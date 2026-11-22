import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@command-ai/shared';
import { LocalBus } from '../src/bus.ts';
import { createPool, DEFAULT_APP_ROLE, grantAppRole, migrate } from '../src/db.ts';
import { loadEnvFiles } from '../src/env.ts';
import { PgRepo } from '../src/pg-repo.ts';
import { sha256 } from '../src/auth.ts';

loadEnvFiles();

// Integração real com o Neon: dono (migrações) + papel restrito (RLS valendo). Dois PgRepo com pools distintos
// fazem o papel de duas instâncias da API. Sem as credenciais, o grupo é ignorado.
const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_URL_APP;
const schema = `ca_repo_${randomBytes(5).toString('hex')}`;
const ORCH = { backoffBaseMs: 0, leaseMs: 400 };

let owner: pg.Pool;
let poolA: pg.Pool;
let poolB: pg.Pool;
let A: PgRepo;
let B: PgRepo;
const busB = new LocalBus();

const uid = () => randomBytes(4).toString('hex');

/** Cria organização, agente, projeto e uma execução em andamento com uma única tarefa. */
async function seedRunning(repo: PgRepo, org: string) {
  return repo.uow(org, 'write', ({ store, orchestrator }) => {
    store.organizations.insert({ id: org, name: org });
    store.agents.insert({ id: `ag-${org}`, organizationId: org, name: 'A', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 });
    store.projects.insert({ id: `pr-${org}`, organizationId: org, name: 'P', workspacePath: '/w' });
    const ex = orchestrator.createDraft({
      organizationId: org,
      projectId: `pr-${org}`,
      agentId: `ag-${org}`,
      goal: 'Meta de teste',
      budgetUsd: 5,
      createdBy: 'u',
      tasks: [{ id: 'a', title: 'Única', agentId: `ag-${org}`, dependsOn: [], risk: 'low' }],
    });
    orchestrator.startExecution(ex.id);
    return ex.id;
  });
}

describe.skipIf(!ownerUrl || !appUrl)('PgRepo: unidade de trabalho sobre o PostgreSQL (duas instâncias)', () => {
  beforeAll(async () => {
    owner = createPool(ownerUrl!);
    await migrate(owner, schema);
    await grantAppRole(owner, schema, DEFAULT_APP_ROLE);
    poolA = createPool(appUrl!);
    poolB = createPool(appUrl!);
    A = new PgRepo({ pool: poolA, schema, orchestrator: ORCH });
    B = new PgRepo({ pool: poolB, schema, orchestrator: ORCH, bus: busB });
  }, 90_000);

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
    await owner?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.end();
  }, 90_000);

  it('o que uma instância grava, a outra enxerga; a leitura só vê a própria organização', async () => {
    const x = `org-x-${uid()}`;
    const y = `org-y-${uid()}`;
    const execX = await seedRunning(A, x);
    await seedRunning(A, y);

    const seen = await B.uow(x, 'read', ({ store }) => ({
      execs: store.executions.all().map((e) => e.id),
      orgs: store.organizations.all().map((o) => o.id),
      tasks: store.tasks.all().map((t) => t.status),
    }));
    expect(seen.execs).toEqual([execX]);
    expect(seen.orgs).toEqual([x]);
    expect(seen.tasks).toEqual(['queued']);
  }, 60_000);

  it('rollback e exceção descartam tudo; leitura nunca grava', async () => {
    const org = `org-r-${uid()}`;
    await seedRunning(A, org);

    const h = await A.begin(org, 'write');
    h.store.agents.insert({ id: 'fantasma', organizationId: org, name: 'F', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 });
    await h.rollback();
    await expect(
      A.uow(org, 'write', ({ store }) => {
        store.agents.insert({ id: 'fantasma2', organizationId: org, name: 'F', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 });
        throw new Error('falha no meio');
      }),
    ).rejects.toThrow('falha no meio');
    await A.uow(org, 'read', ({ store }) => {
      store.agents.insert({ id: 'fantasma3', organizationId: org, name: 'F', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 });
    });

    const agents = await B.uow(org, 'read', ({ store }) => store.agents.all().map((a) => a.id));
    expect(agents).toEqual([`ag-${org}`]);
  }, 60_000);

  it('reivindicação concorrente por duas instâncias: exatamente uma vence e a tentativa é 1', async () => {
    const org = `org-c-${uid()}`;
    await seedRunning(A, org);
    // Pré-aquece as conexões e segura cada transação depois de carregar o estado: sem a trava por organização,
    // todas enxergariam a tarefa "na fila" e todas venceriam. (Verificado por mutação: sem a trava, este teste falha.)
    await Promise.all([...Array(10)].map(() => poolA.query('SELECT 1')));
    await Promise.all([...Array(10)].map(() => poolB.query('SELECT 1')));
    const attempts = Array.from({ length: 12 }, (_, i) =>
      (i % 2 === 0 ? A : B).uow(org, 'write', async ({ orchestrator }) => {
        const task = orchestrator.claimTask(org, `runner-${i}`);
        await new Promise((r) => setTimeout(r, 250));
        return task;
      }),
    );
    const results = await Promise.all(attempts);
    const winners = results.filter((t) => t !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.attempts).toBe(1);
  }, 90_000);

  it('a numeração dos eventos não tem buracos nem repetição sob escrita concorrente', async () => {
    const org = `org-e-${uid()}`;
    const execId = await seedRunning(A, org);
    const taskId = `${execId}:a`;
    await Promise.all(Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? A : B).uow(org, 'write', ({ orchestrator }) => orchestrator.appendLog(taskId, `linha ${i}`))));

    const events = await B.eventsAfter(org, execId, 0);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(events.filter((e) => e.type === 'log.appended')).toHaveLength(14);

    const after = await A.eventsAfter(org, execId, seqs.length - 3);
    expect(after.map((e) => e.seq)).toEqual(seqs.slice(-3));
  }, 90_000);

  it('recuperação: tarefa abandonada com lease vencido volta à fila e outra instância a reivindica', async () => {
    const org = `org-k-${uid()}`;
    await seedRunning(A, org);
    const first = await A.uow(org, 'write', ({ orchestrator }) => orchestrator.claimTask(org, 'runner-morto'));
    expect(first?.attempts).toBe(1);
    // O Runner "morre": nenhum heartbeat. Antes do lease vencer, a varredura não faz nada.
    expect(await B.uow(org, 'write', ({ orchestrator }) => orchestrator.sweep())).toEqual({ requeued: 0, failed: 0, expiredExecutions: 0 });
    await new Promise((r) => setTimeout(r, 500));
    expect(await B.uow(org, 'write', ({ orchestrator }) => orchestrator.sweep())).toEqual({ requeued: 1, failed: 0, expiredExecutions: 0 });
    const second = await B.uow(org, 'write', ({ orchestrator }) => orchestrator.claimTask(org, 'runner-novo'));
    expect(second?.attempts).toBe(2);
    expect(second?.runnerId).toBe('runner-novo');
  }, 90_000);

  it('buscas anteriores à autenticação devolvem o registro certo e nada de outras chaves', async () => {
    const org = `org-l-${uid()}`;
    const email = `l-${uid()}@example.com`;
    const sub = `sub-${uid()}`;
    const token = `car_${uid()}`;
    const sessionToken = `tok-${uid()}`;
    await A.uow(org, 'write', ({ store }) => {
      store.organizations.insert({ id: org, name: org });
      store.users.insert({ id: `u-${org}`, neonAuthId: sub, organizationId: org, name: 'L', email, role: 'owner', passwordHash: '', mfaSecret: null, mfaEnabled: false, createdAt: new Date().toISOString() });
      store.sessions.insert({ id: sha256(sessionToken), userId: `u-${org}`, organizationId: org, expiresAt: Date.now() + 1000, lastSeenAt: Date.now() });
      store.runners.insert({ id: `rn-${org}`, organizationId: org, name: 'N', tokenHash: sha256(token), createdAt: new Date().toISOString(), revoked: false });
      store.runners.insert({ id: `rn2-${org}`, organizationId: org, name: 'Revogado', tokenHash: sha256('outro'), createdAt: new Date().toISOString(), revoked: true });
    });

    expect((await B.findUserByEmail(email))?.id).toBe(`u-${org}`);
    expect((await B.findUserByNeonSub(sub))?.organizationId).toBe(org);
    expect((await B.findSession(sha256(sessionToken)))?.userId).toBe(`u-${org}`);
    expect((await B.findRunnerByTokenHash(sha256(token)))?.id).toBe(`rn-${org}`);
    expect(await B.findRunnerByTokenHash(sha256('outro'))).toBeNull(); // revogado
    expect(await B.findUserByEmail('ninguem@example.com')).toBeNull();
    expect(await B.findSession(sha256('inventado'))).toBeNull();
    expect(await B.listOrganizationIds()).toContain(org);
  }, 60_000);

  it('e-mail repetido, mesmo em outra organização, é recusado e a transação inteira é desfeita', async () => {
    const email = `dup-${uid()}@example.com`;
    const mk = (org: string) => (({ store }: { store: import('../src/store.ts').Store }) => {
      store.organizations.insert({ id: org, name: org });
      store.users.insert({ id: `u-${org}`, organizationId: org, name: 'D', email, role: 'owner', passwordHash: '', mfaSecret: null, mfaEnabled: false, createdAt: new Date().toISOString() });
    });
    const o1 = `org-d1-${uid()}`;
    const o2 = `org-d2-${uid()}`;
    await A.uow(o1, 'write', mk(o1));
    await expect(B.uow(o2, 'write', mk(o2))).rejects.toMatchObject({ code: '23505' });
    expect(await B.listOrganizationIds()).not.toContain(o2);
  }, 60_000);

  it('hasClaimable acompanha a fila e respeita a organização e a espera', async () => {
    const org = `org-h-${uid()}`;
    const other = `org-h2-${uid()}`;
    await seedRunning(A, org);
    expect(await B.hasClaimable(org)).toBe(true);
    expect(await B.hasClaimable(other)).toBe(false);
    await A.uow(org, 'write', ({ orchestrator }) => orchestrator.claimTask(org, 'r'));
    expect(await B.hasClaimable(org)).toBe(false);
  }, 60_000);

  it('só publica os eventos depois do commit, e nada quando há rollback', async () => {
    const org = `org-p-${uid()}`;
    const execId = await seedRunning(B, org);
    const got: EventEnvelope[] = [];
    const off = busB.subscribe(execId, (e) => got.push(e));

    const h = await B.begin(org, 'write');
    h.orchestrator.appendLog(`${execId}:a`, 'antes do commit');
    expect(got).toHaveLength(0);
    await h.rollback();
    expect(got).toHaveLength(0);

    await B.uow(org, 'write', ({ orchestrator }) => orchestrator.appendLog(`${execId}:a`, 'depois do commit'));
    expect(got.map((e) => e.payload.line)).toEqual(['depois do commit']);
    off();
  }, 60_000);

  it('toques leves (heartbeat de sessão e de Runner) atualizam sem carregar a organização', async () => {
    const org = `org-t-${uid()}`;
    const sTok = `s-${uid()}`;
    await A.uow(org, 'write', ({ store }) => {
      store.organizations.insert({ id: org, name: org });
      store.sessions.insert({ id: sha256(sTok), userId: 'u', organizationId: org, expiresAt: 1, lastSeenAt: 1 });
      store.runners.insert({ id: `rn-${org}`, organizationId: org, name: 'N', tokenHash: sha256(`t-${org}`), createdAt: 'x', revoked: false });
    });
    await B.touchSession(org, sha256(sTok), 5_000, 9_000);
    await B.touchRunner(org, `rn-${org}`, '2026-02-02T00:00:00.000Z');
    const seen = await A.uow(org, 'read', ({ store }) => ({ s: store.sessions.all()[0], r: store.runners.all()[0] }));
    expect(seen.s).toMatchObject({ lastSeenAt: 5_000, expiresAt: 9_000 });
    expect(seen.r?.lastSeenAt).toBe('2026-02-02T00:00:00.000Z');
  }, 60_000);
});
