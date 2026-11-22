import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../src/db.ts';
import { loadEnvFiles } from '../src/env.ts';
import { PgRepo } from '../src/pg-repo.ts';

loadEnvFiles();

// Integração real com o PostgreSQL da Neon, em um schema descartável apagado no fim.
// Aqui a conexão é a do dono (ignora RLS): o foco é durabilidade e fidelidade dos dados. O RLS é testado em rls.test.ts.
// Sem credenciais (por exemplo, no CI público), o grupo é ignorado em vez de falhar.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const schema = `ca_test_${randomBytes(5).toString('hex')}`;
let pool: pg.Pool;
const open = () => new PgRepo({ pool: createPool(url!), schema, orchestrator: { backoffBaseMs: 0 } });

describe.skipIf(!url)('persistência no PostgreSQL (Neon)', () => {
  beforeAll(async () => {
    pool = createPool(url!);
    await migrate(pool, schema);
  }, 60_000);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }, 60_000);

  it('aplica as migrações uma única vez (idempotente)', async () => {
    expect(await migrate(pool, schema)).toEqual([]);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
      [schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['audit', 'events', 'records', 'schema_migrations']);
    const applied = await pool.query<{ name: string }>(`SELECT name FROM "${schema}".schema_migrations ORDER BY name`);
    // Todas as migrações da pasta foram aplicadas, na ordem (a lista vem da pasta para não envelhecer a cada migração nova).
    const onDisk = (await readdir(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(4);
    expect(applied.rows.map((r) => r.name)).toEqual(onDisk);
  });

  it('sobrevive a um "reinício": novo processo, mesmo banco, estado idêntico e execução retomável', async () => {
    const before = open();
    const org = 'org-1';
    const execId = await before.uow(org, 'write', ({ store, orchestrator }) => {
      store.organizations.insert({ id: org, name: 'Acme' });
      store.agents.insert({ id: 'ag-1', organizationId: org, name: 'Auditor', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 });
      store.projects.insert({ id: 'pr-1', organizationId: org, name: 'Repo', workspacePath: '/work/repo' });
      const exec = orchestrator.createDraft({
        organizationId: org,
        projectId: 'pr-1',
        agentId: 'ag-1',
        goal: 'Auditar o repositório',
        budgetUsd: 5,
        createdBy: 'u-1',
        tasks: [
          { id: 'a', title: 'Analisar', agentId: 'ag-1', dependsOn: [], risk: 'low' },
          { id: 'b', title: 'Publicar', agentId: 'ag-1', dependsOn: ['a'], risk: 'high' },
        ],
      });
      orchestrator.startExecution(exec.id);
      const claimed = orchestrator.claimTask(org, 'runner-1')!;
      orchestrator.completeTask(claimed.id, { output: 'ok', usage: { model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500 } }, { attempt: 1 });
      store.audit({ organizationId: org, actor: 'u-1', action: 'teste', target: exec.id });
      return exec.id;
    });
    const snapshot = await before.uow(org, 'read', ({ store }) => ({
      exec: store.executions.get(execId),
      tasks: store.tasks.filter((t) => t.executionId === execId).map((t) => [t.id, t.status]),
    }));
    const eventsBefore = await before.eventsAfter(org, execId, 0);
    await before.close(); // "o processo morreu"

    const after = open(); // processo novo
    const reborn = await after.uow(org, 'read', ({ store }) => ({
      exec: store.executions.get(execId),
      tasks: store.tasks.filter((t) => t.executionId === execId).map((t) => [t.id, t.status]),
      approvals: store.approvals.all().map((a) => a.status),
    }));
    expect(reborn.exec).toEqual(snapshot.exec);
    expect(reborn.tasks).toEqual(snapshot.tasks);
    expect(reborn.approvals).toEqual(['pending']);
    expect(await after.eventsAfter(org, execId, 0)).toEqual(eventsBefore);
    expect((await after.auditList(org, 10)).map((a) => a.action)).toContain('teste');

    // A aprovação pendente continua decidível, e a numeração dos eventos continua de onde parou.
    const lastSeq = eventsBefore.at(-1)!.seq;
    await after.uow(org, 'write', ({ store, orchestrator }) => {
      orchestrator.decideApproval(store.approvals.all()[0]!.id, 'approved', 'u-1');
    });
    expect((await after.eventsAfter(org, execId, lastSeq))[0]?.seq).toBe(lastSeq + 1);
    await after.close();
  }, 90_000);

  it('grava atualizações e remoções', async () => {
    const repo = open();
    await repo.uow('org-2', 'write', ({ store }) => {
      store.organizations.insert({ id: 'org-2', name: 'Antes' });
      store.agents.insert({ id: 'ag-del', organizationId: 'org-2', name: 'Apagar', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 });
    });
    await repo.uow('org-2', 'write', ({ store }) => {
      store.organizations.update('org-2', { name: 'Depois' });
      store.agents.delete('ag-del');
    });
    const seen = await repo.uow('org-2', 'read', ({ store }) => ({ name: store.organizations.get('org-2')?.name, agent: store.agents.get('ag-del') }));
    expect(seen).toEqual({ name: 'Depois', agent: undefined });
    await repo.close();
  }, 60_000);

  it('grava com segurança valores com aspas, barras invertidas e tentativas de injeção de SQL', async () => {
    const repo = open();
    const nasty = `x'); DROP TABLE "${schema}".records; --  \\ \\' $$ ç ✓ "aspas"`;
    const org = "org-'inj";
    await repo.uow(org, 'write', ({ store }) => {
      store.organizations.insert({ id: org, name: nasty });
      store.agents.insert({ id: "ag-'inj", organizationId: org, name: nasty, role: 'r', instructions: "i'; DELETE FROM x; --", providerKind: 'simulated', model: 'm', budgetUsd: 1 });
    });
    const seen = await repo.uow(org, 'read', ({ store }) => ({ org: store.organizations.get(org)?.name, instr: store.agents.get("ag-'inj")?.instructions }));
    expect(seen).toEqual({ org: nasty, instr: "i'; DELETE FROM x; --" });
    const tables = await pool.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'records'`, [schema]);
    expect(tables.rows[0].n).toBe(1); // a tabela continua existindo
    await repo.close();
  }, 60_000);

  it('rejeita nome de schema perigoso (injeção em identificador)', () => {
    expect(() => new PgRepo({ pool, schema: 'x"; DROP SCHEMA public; --' })).toThrow(/schema/i);
  });
});
