import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, DEFAULT_APP_ROLE, grantAppRole, migrate } from '../src/db.ts';
import { loadEnvFiles } from '../src/env.ts';
import { PgRepo } from '../src/pg-repo.ts';
import { MemoryRepo, type Repo } from '../src/repo.ts';
import { runSweep } from '../src/sweep.ts';

loadEnvFiles();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => randomBytes(4).toString('hex');

/** Cria organização com uma execução em andamento e uma tarefa já reivindicada (o Runner "some" depois). */
async function runningAndClaimed(repo: Repo, org: string) {
  return repo.uow(org, 'write', ({ store, orchestrator }) => {
    // Ids únicos por organização: a chave primária é global, e o RLS barra (corretamente) sobrescrever linha de outra organização.
    const agent = `ag-${org}`;
    const project = `pr-${org}`;
    store.organizations.insert({ id: org, name: org });
    store.agents.insert({ id: agent, organizationId: org, name: 'A', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 });
    store.projects.insert({ id: project, organizationId: org, name: 'P', workspacePath: '/w' });
    const ex = orchestrator.createDraft({ organizationId: org, projectId: project, agentId: agent, goal: 'Meta de teste', budgetUsd: 5, createdBy: 'u', tasks: [{ id: 'a', title: 'Única', agentId: agent, dependsOn: [], risk: 'low' }] });
    orchestrator.startExecution(ex.id);
    orchestrator.claimTask(org, 'runner-morto');
    return ex.id;
  });
}

describe('runSweep em memória', () => {
  it('recupera a tarefa de um Runner que sumiu e resume o que fez', async () => {
    const repo = new MemoryRepo({ orchestrator: { leaseMs: 100, backoffBaseMs: 0 } });
    const execId = await runningAndClaimed(repo, 'org-m');
    expect(await runSweep(repo)).toMatchObject({ orgs: 1, requeued: 0 }); // lease ainda válido
    await sleep(160);
    expect(await runSweep(repo)).toEqual({ orgs: 1, requeued: 1, failed: 0, expiredExecutions: 0, errors: 0 });
    expect(repo.store.tasks.get(`${execId}:a`)?.status).toBe('queued');
  });

  it('um erro numa organização não impede a varredura das outras', async () => {
    const repo = new MemoryRepo({ orchestrator: { leaseMs: 50, backoffBaseMs: 0 } });
    await runningAndClaimed(repo, 'org-ruim');
    await runningAndClaimed(repo, 'org-bom');
    const original = repo.uow.bind(repo);
    repo.uow = (async (org: string, mode: 'read' | 'write', fn: never) => {
      if (org === 'org-ruim') throw new Error('falha de teste');
      return original(org, mode, fn);
    }) as typeof repo.uow;
    await sleep(100);
    const out = await runSweep(repo, { log: () => undefined });
    expect(out.errors).toBe(1); // a organização com falha foi registrada…
    expect(out.requeued).toBeGreaterThanOrEqual(1); // …e a outra foi varrida mesmo assim (em memória o Store é único, então pode pegar as duas)
  });
});

const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_URL_APP;
const schema = `ca_swp_${uid()}`;

describe.skipIf(!ownerUrl || !appUrl)('runSweep no PostgreSQL (duas instâncias do Worker)', () => {
  let owner: pg.Pool;
  const pools: pg.Pool[] = [];
  const open = (orch = { leaseMs: 300, backoffBaseMs: 0 }) => {
    const pool = createPool(appUrl!);
    pools.push(pool);
    return new PgRepo({ pool, schema, orchestrator: orch });
  };

  beforeAll(async () => {
    owner = createPool(ownerUrl!);
    await migrate(owner, schema);
    await grantAppRole(owner, schema, DEFAULT_APP_ROLE);
  }, 90_000);
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await owner?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.end();
  }, 90_000);

  it('só varre organizações com execução em andamento', async () => {
    const w = open();
    const busy = `org-b-${uid()}`;
    const idle = `org-i-${uid()}`;
    await runningAndClaimed(w, busy);
    await w.uow(idle, 'write', ({ store }) => void store.organizations.insert({ id: idle, name: idle })); // sem execução
    const active = await w.listActiveOrganizationIds();
    expect(active).toContain(busy);
    expect(active).not.toContain(idle);
  }, 90_000);

  it('recupera a tarefa abandonada; dois Workers varrendo ao mesmo tempo recuperam só uma vez', async () => {
    const w1 = open();
    const w2 = open();
    const org = `org-r-${uid()}`;
    const execId = await runningAndClaimed(w1, org);
    await sleep(450); // lease (300 ms) vence

    const [r1, r2] = await Promise.all([runSweep(w1), runSweep(w2)]);
    const mine = (r: typeof r1) => r.requeued;
    expect(mine(r1) + mine(r2)).toBeGreaterThanOrEqual(1);
    const task = await w1.uow(org, 'read', ({ store }) => store.tasks.get(`${execId}:a`));
    expect(task?.status).toBe('queued');
    expect(task?.attempts).toBe(1); // recuperada uma única vez: nada de tentativa dupla
    const logs = (await w1.eventsAfter(org, execId, 0)).filter((e) => String(e.payload.line ?? '').includes('lease'));
    expect(logs).toHaveLength(1);
    // Uma terceira varredura não acha mais nada para fazer.
    expect((await runSweep(w2)).requeued).toBe(0);
  }, 90_000);

  it('encerra execuções que passaram do prazo', async () => {
    const w = open({ leaseMs: 60_000, backoffBaseMs: 0, maxExecutionMs: 200 } as never);
    const org = `org-d-${uid()}`;
    const execId = await runningAndClaimed(w, org);
    await sleep(350);
    const out = await runSweep(w);
    expect(out.expiredExecutions).toBeGreaterThanOrEqual(1);
    const exec = await w.uow(org, 'read', ({ store }) => store.executions.get(execId));
    expect(exec?.status).toBe('failed');
    expect(exec?.failureReason).toBe('deadline_exceeded');
  }, 90_000);
});
