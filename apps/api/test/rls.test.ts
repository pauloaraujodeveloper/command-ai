import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, DEFAULT_APP_ROLE, grantAppRole, migrate } from '../src/db.ts';
import { loadEnvFiles } from '../src/env.ts';
import { PgRepo } from '../src/pg-repo.ts';

loadEnvFiles();

// Integração real com o Neon: schema descartável, dono (migrações) e papel restrito da aplicação (RLS valendo).
// Sem as duas credenciais, o grupo é ignorado em vez de falhar.
const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_URL_APP;
const schema = `ca_rls_${randomBytes(5).toString('hex')}`;
let owner: pg.Pool;
let app: pg.Pool;

/** Executa `fn` numa transação com o contexto de organização definido, como a API faz. */
async function asOrg<T>(org: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    if (org !== null) await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe.skipIf(!ownerUrl || !appUrl)('RLS no PostgreSQL com o papel restrito da aplicação', () => {
  beforeAll(async () => {
    owner = createPool(ownerUrl!);
    await migrate(owner, schema);
    await grantAppRole(owner, schema, DEFAULT_APP_ROLE);
    app = createPool(appUrl!);
    // Dados de duas organizações, inseridos pelo dono (que ignora RLS) só para montar o cenário.
    await owner.query(`INSERT INTO "${schema}".records (kind, id, organization_id, data) VALUES
      ('organization','org-a','org-a','{"id":"org-a","name":"A"}'),
      ('organization','org-b','org-b','{"id":"org-b","name":"B"}'),
      ('agent','ag-a','org-a','{"id":"ag-a","organizationId":"org-a"}'),
      ('agent','ag-b','org-b','{"id":"ag-b","organizationId":"org-b"}')`);
    await owner.query(`INSERT INTO "${schema}".audit (id, organization_id, at, data) VALUES
      ('au-a','org-a',now(),'{"id":"au-a"}'),('au-b','org-b',now(),'{"id":"au-b"}')`);
    await owner.query(`INSERT INTO "${schema}".events (execution_id, seq, ts, data, organization_id) VALUES
      ('ex-a',1,now(),'{}','org-a'),('ex-b',1,now(),'{}','org-b')`);
  }, 90_000);

  afterAll(async () => {
    await app?.end();
    await owner?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.end();
  }, 90_000);

  it('o papel da aplicação não ignora RLS nem tem poderes administrativos', async () => {
    const r = await owner.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1`, [DEFAULT_APP_ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('um SELECT sem filtro só enxerga as linhas da organização do contexto', async () => {
    const a = await asOrg('org-a', (c) => c.query(`SELECT id FROM "${schema}".records ORDER BY id`));
    expect(a.rows.map((r) => r.id)).toEqual(['ag-a', 'org-a']);
    const b = await asOrg('org-b', (c) => c.query(`SELECT id FROM "${schema}".records ORDER BY id`));
    expect(b.rows.map((r) => r.id)).toEqual(['ag-b', 'org-b']);
    expect((await asOrg('org-a', (c) => c.query(`SELECT id FROM "${schema}".audit`))).rows.map((r) => r.id)).toEqual(['au-a']);
    expect((await asOrg('org-b', (c) => c.query(`SELECT execution_id FROM "${schema}".events`))).rows.map((r) => r.execution_id)).toEqual(['ex-b']);
  });

  it('sem contexto de organização (falha fechada) nada é visível nem gravável', async () => {
    const none = await asOrg(null, (c) => c.query(`SELECT id FROM "${schema}".records`));
    expect(none.rowCount).toBe(0);
    await expect(
      asOrg(null, (c) => c.query(`INSERT INTO "${schema}".records (kind, id, organization_id, data) VALUES ('agent','x','org-a','{}')`)),
    ).rejects.toThrow(/row-level security/i);
  });

  it('não grava linha de outra organização, nem altera nem apaga as dela', async () => {
    await expect(
      asOrg('org-a', (c) => c.query(`INSERT INTO "${schema}".records (kind, id, organization_id, data) VALUES ('agent','evil','org-b','{}')`)),
    ).rejects.toThrow(/row-level security/i);
    // Tentar mover uma linha própria para outra organização também é barrado (WITH CHECK).
    await expect(
      asOrg('org-a', (c) => c.query(`UPDATE "${schema}".records SET organization_id = 'org-b' WHERE id = 'ag-a'`)),
    ).rejects.toThrow(/row-level security/i);
    const upd = await asOrg('org-a', (c) => c.query(`UPDATE "${schema}".records SET data = '{"hacked":true}' WHERE id = 'ag-b'`));
    expect(upd.rowCount).toBe(0);
    const del = await asOrg('org-a', (c) => c.query(`DELETE FROM "${schema}".records WHERE id = 'ag-b'`));
    expect(del.rowCount).toBe(0);
    const intact = await owner.query(`SELECT data FROM "${schema}".records WHERE id = 'ag-b'`);
    expect(intact.rows[0].data).toEqual({ id: 'ag-b', organizationId: 'org-b' });
  });

  it('um valor de contexto forjado dentro da transação não ajuda a ler outra organização sem querer', async () => {
    // Quem controla o SQL controla o contexto; por isso a API só define o contexto com o id vindo da própria linha/sessão.
    const r = await asOrg("org-a' OR '1'='1", (c) => c.query(`SELECT id FROM "${schema}".records`));
    expect(r.rowCount).toBe(0);
  });

  it('o papel não faz DDL, não lê o controle de migrações e não troca de papel', async () => {
    await expect(asOrg('org-a', (c) => c.query(`DROP TABLE "${schema}".records`))).rejects.toThrow(/must be owner|permission denied/i);
    await expect(asOrg('org-a', (c) => c.query(`ALTER TABLE "${schema}".records DISABLE ROW LEVEL SECURITY`))).rejects.toThrow(/must be owner|permission denied/i);
    await expect(asOrg('org-a', (c) => c.query(`SELECT * FROM "${schema}".schema_migrations`))).rejects.toThrow(/permission denied/i);
    await expect(asOrg('org-a', (c) => c.query(`SET ROLE neondb_owner`))).rejects.toThrow(/permission denied|must be member/i);
  });

  it('o código de negócio da API funciona de ponta a ponta com o papel restrito, para duas organizações', async () => {
    const repo = new PgRepo({ pool: app, schema, orchestrator: { backoffBaseMs: 0 } });
    const ids: Record<string, string> = {};
    for (const org of ['org-x', 'org-y']) {
      ids[org] = await repo.uow(org, 'write', ({ store, orchestrator }) => {
        store.organizations.insert({ id: org, name: org });
        store.agents.insert({ id: `ag-${org}`, organizationId: org, name: 'A', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 });
        store.projects.insert({ id: `pr-${org}`, organizationId: org, name: 'P', workspacePath: '/w' });
        const ex = orchestrator.createDraft({
          organizationId: org,
          projectId: `pr-${org}`,
          agentId: `ag-${org}`,
          goal: `Meta ${org}`,
          budgetUsd: 5,
          createdBy: 'u',
          tasks: [{ id: 'a', title: 'Passo', agentId: `ag-${org}`, dependsOn: [], risk: 'low' }],
        });
        orchestrator.startExecution(ex.id);
        const t = orchestrator.claimTask(org, 'r')!;
        orchestrator.completeTask(t.id, { output: 'ok', usage: { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 } }, { attempt: 1 });
        store.audit({ organizationId: org, actor: 'u', action: 'teste', target: ex.id });
        return ex.id;
      });
    }

    for (const org of ['org-x', 'org-y']) {
      const other = org === 'org-x' ? 'org-y' : 'org-x';
      const seen = await repo.uow(org, 'read', ({ store }) => ({
        execs: store.executions.all().map((e) => [e.id, e.status]),
        tasks: store.tasks.all().map((t) => t.status),
        orgs: store.organizations.all().map((o) => o.id),
      }));
      expect(seen.execs).toEqual([[ids[org], 'succeeded']]);
      expect(seen.tasks).toEqual(['done']);
      expect(seen.orgs).toEqual([org]); // nunca enxerga a outra organização
      expect((await repo.eventsAfter(org, ids[org]!, 0)).length).toBeGreaterThan(0);
      expect(await repo.eventsAfter(org, ids[other]!, 0)).toEqual([]); // eventos de outra organização não aparecem
      expect((await repo.auditList(org, 10)).map((a) => a.action)).toContain('teste');
    }

    // E tudo o que a API gravou carrega o organization_id certo no banco.
    const rows = await owner.query(`SELECT organization_id, count(*)::int n FROM "${schema}".events WHERE execution_id = ANY($1) GROUP BY 1 ORDER BY 1`, [[ids['org-x'], ids['org-y']]]);
    expect(rows.rows.map((r) => r.organization_id)).toEqual(['org-x', 'org-y']);
  }, 90_000);

  it('um erro de código que tente gravar linha de outra organização é barrado pelo banco e nada é gravado', async () => {
    const repo = new PgRepo({ pool: app, schema });
    await expect(
      repo.uow('org-a', 'write', ({ store }) => {
        store.agents.insert({ id: 'vazamento', organizationId: 'org-b', name: 'X', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 });
        store.agents.insert({ id: 'legitimo', organizationId: 'org-a', name: 'Y', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 });
      }),
    ).rejects.toThrow(/row-level security/i);
    // A transação inteira foi desfeita: nem a gravação legítima da mesma unidade sobrou.
    const check = await owner.query(`SELECT id FROM "${schema}".records WHERE id IN ('vazamento','legitimo')`);
    expect(check.rowCount).toBe(0);
  }, 60_000);

  it('uma linha sem organização não pode ser gravada pelo papel restrito', async () => {
    const repo = new PgRepo({ pool: app, schema });
    await expect(
      repo.uow('org-a', 'write', ({ store }) => {
        store.agents.insert({ id: 'sem-org', name: 'X', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 } as never);
      }),
    ).rejects.toThrow(/row-level security|null value/i);
    expect((await owner.query(`SELECT 1 FROM "${schema}".records WHERE id = 'sem-org'`)).rowCount).toBe(0);
  }, 60_000);
});
