import type { EventEnvelope } from '@command-ai/shared';
import type { AuditEntry, Store } from './store.ts';

/** Escapa um valor como literal SQL (feito pelo driver, nunca por concatenação direta). */
export type Lit = (v: string | number | null) => string;

/** Geradores das instruções de gravação. `s` é o nome do schema já validado e entre aspas. */
export const upsertSql = (s: string, kind: string, row: { id: string }, org: string | null, lit: Lit): string =>
  `INSERT INTO ${s}.records (kind, id, organization_id, data) VALUES (${lit(kind)}, ${lit(row.id)}, ${lit(org)}, ${lit(JSON.stringify(row))})
   ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, organization_id = EXCLUDED.organization_id, updated_at = now()`;

export const removeSql = (s: string, kind: string, id: string, lit: Lit): string =>
  `DELETE FROM ${s}.records WHERE kind = ${lit(kind)} AND id = ${lit(id)}`;

export const eventSql = (s: string, e: EventEnvelope, org: string | null, lit: Lit): string =>
  `INSERT INTO ${s}.events (execution_id, seq, ts, data, organization_id)
   VALUES (${lit(e.executionId)}, ${lit(e.seq)}, ${lit(e.ts)}, ${lit(JSON.stringify(e))}, ${lit(org)}) ON CONFLICT DO NOTHING`;

export const auditSql = (s: string, a: AuditEntry, lit: Lit): string =>
  `INSERT INTO ${s}.audit (id, organization_id, at, data) VALUES (${lit(a.id)}, ${lit(a.organizationId)}, ${lit(a.at)}, ${lit(JSON.stringify(a))}) ON CONFLICT DO NOTHING`;

/** Coloca um registro lido do banco na tabela certa do store, sem disparar gravação. */
export function hydrateRecord(store: Store, kind: string, data: unknown): void {
  const tables: Record<string, { hydrate(row: never): void }> = {
    organization: store.organizations,
    user: store.users,
    session: store.sessions,
    provider: store.providers,
    agent: store.agents,
    project: store.projects,
    execution: store.executions,
    task: store.tasks,
    approval: store.approvals,
    idempotency: store.idempotency,
    runner: store.runners,
  };
  tables[kind]?.hydrate(data as never);
}
