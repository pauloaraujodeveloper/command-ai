import type pg from 'pg';
import type { EventEnvelope } from '@command-ai/shared';
import { LocalBus, type EventBus } from './bus.ts';
import { SCHEMA_RE } from './env.ts';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.ts';
import type { Repo, UnitContext, UnitHandle, UnitMode } from './repo.ts';
import { auditSql, eventSql, hydrateRecord, removeSql, upsertSql, type Lit } from './sql.ts';
import { createStore, organizationIdOf, type AuditEntry, type Runner, type Session, type Sink, type User } from './store.ts';

interface PgRepoOptions {
  /** Pool com o papel restrito (RLS valendo). */
  pool: pg.Pool;
  schema: string;
  orchestrator?: OrchestratorOptions;
  bus?: EventBus;
  onError?: (message: string, err: unknown) => void;
}

/** Junta as mudanças feitas pelo código de negócio para gravá-las todas na mesma transação. */
class Collector implements Sink {
  records = new Map<string, { op: 'upsert'; kind: string; row: { id: string; organizationId?: string } } | { op: 'remove'; kind: string; id: string; org: string | null }>();
  events: Array<{ e: EventEnvelope; org: string | null }> = [];
  audits: AuditEntry[] = [];

  upsert(kind: string, row: { id: string; organizationId?: string }): void {
    this.records.set(`${kind}\u0000${row.id}`, { op: 'upsert', kind, row }); // a última escrita vence
  }
  remove(kind: string, id: string, org: string | null): void {
    this.records.set(`${kind}\u0000${id}`, { op: 'remove', kind, id, org });
  }
  event(e: EventEnvelope, org: string | null): void {
    this.events.push({ e, org });
  }
  audit(a: AuditEntry): void {
    this.audits.push(a);
  }
  get empty(): boolean {
    return this.records.size === 0 && this.events.length === 0 && this.audits.length === 0;
  }
}

/**
 * Repositório sobre o PostgreSQL (Neon). Cada unidade de trabalho é UMA transação:
 *  1. define o contexto de organização (RLS);
 *  2. em escrita, pega uma trava consultiva por organização, o que serializa as escritas entre processos;
 *  3. carrega os registros da organização para um Store temporário e roda o código de negócio sobre ele;
 *  4. grava as mudanças, confirma e só então publica os eventos ao vivo.
 */
export class PgRepo implements Repo {
  readonly kind = 'pg' as const;
  readonly bus: EventBus;
  private readonly s: string;
  private readonly schema: string;
  private readonly pool: pg.Pool;
  private readonly orchOptions?: OrchestratorOptions;
  private readonly onError: (message: string, err: unknown) => void;

  constructor(opts: PgRepoOptions) {
    if (!SCHEMA_RE.test(opts.schema)) throw new Error('Nome de schema inválido');
    this.schema = opts.schema;
    this.s = `"${opts.schema}"`;
    this.pool = opts.pool;
    this.orchOptions = opts.orchestrator;
    this.bus = opts.bus ?? new LocalBus();
    this.onError = opts.onError ?? ((m, e) => console.error(m, e));
  }

  async begin(organizationId: string, mode: UnitMode): Promise<UnitHandle> {
    const client = await this.pool.connect();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        client.release();
      }
    };
    try {
      // Tudo numa única ida ao servidor: abrir a transação, definir o contexto, pegar a trava (em escrita) e ler a organização.
      // Em leitura o COMMIT vai junto: a fotografia já vem na resposta e a transação não precisa continuar aberta.
      const lit: Lit = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(Math.trunc(v)) : client.escapeLiteral(v));
      const stmts = [
        'BEGIN',
        // Rede de segurança: se este processo morrer com a transação aberta, o banco a encerra e solta a trava.
        `SET LOCAL idle_in_transaction_session_timeout = '60s'`,
        `SELECT set_config('app.organization_id', ${lit(organizationId)}, true)`,
        ...(mode === 'write' ? [`SELECT pg_advisory_xact_lock(hashtextextended(${lit(`${this.schema}:org:${organizationId}`)}, 0))`] : []),
        `SELECT kind, data FROM ${this.s}.records`,
        ...(mode === 'read' ? ['COMMIT'] : []),
      ];
      const results = (await client.query(stmts.join('; '))) as unknown as pg.QueryResult[];
      // Posição do SELECT dos registros: BEGIN, SET LOCAL, set_config, [trava só em escrita], SELECT.
      const rows = results[mode === 'write' ? 4 : 3]!;

      const collector = new Collector();
      const store = createStore(collector);
      for (const r of rows.rows as Array<{ kind: string; data: unknown }>) hydrateRecord(store, r.kind, r.data);
      const orchestrator = new Orchestrator(store, this.orchOptions);

      if (mode === 'read') release();

      let done = false;
      const handle: UnitHandle = {
        store,
        orchestrator,
        commit: async () => {
          if (done) return;
          done = true;
          if (mode === 'read') return; // leitura nunca grava
          try {
            if (!collector.empty) {
              const lit: Lit = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(Math.trunc(v)) : client.escapeLiteral(v));
              const stmts: string[] = [];
              for (const r of collector.records.values()) {
                stmts.push(r.op === 'upsert' ? upsertSql(this.s, r.kind, r.row, organizationIdOf(r.kind, r.row), lit) : removeSql(this.s, r.kind, r.id, lit));
              }
              for (const { e, org } of collector.events) stmts.push(eventSql(this.s, e, org, lit));
              for (const a of collector.audits) stmts.push(auditSql(this.s, a, lit));
              await client.query(stmts.join(';\n'));
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            release();
            throw err;
          }
          release();
          // Só depois do commit: quem assiste ao vivo nunca vê um evento que pode ser desfeito.
          for (const { e } of collector.events) {
            try {
              await this.bus.publish(e);
            } catch (err) {
              this.onError('[repo] falha ao publicar evento', err);
            }
          }
        },
        rollback: async () => {
          if (done) return;
          done = true;
          if (mode === 'write') await client.query('ROLLBACK').catch(() => undefined);
          release();
        },
      };
      return handle;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      release();
      throw err;
    }
  }

  async uow<T>(organizationId: string, mode: UnitMode, fn: (ctx: UnitContext) => T | Promise<T>): Promise<T> {
    const handle = await this.begin(organizationId, mode);
    try {
      const out = await fn({ store: handle.store, orchestrator: handle.orchestrator });
      await handle.commit();
      return out;
    } catch (err) {
      await handle.rollback();
      throw err;
    }
  }

  /* ---------- buscas anteriores à autenticação (funções SECURITY DEFINER) ---------- */

  private async lookup<T>(fn: string, arg: string): Promise<T | null> {
    const r = await this.pool.query<{ d: T | null }>(`SELECT ${this.s}.${fn}($1) AS d`, [arg]);
    return r.rows[0]?.d ?? null;
  }
  findSession(idHash: string): Promise<Session | null> {
    return this.lookup<Session>('find_session', idHash);
  }
  findRunnerByTokenHash(hash: string): Promise<Runner | null> {
    return this.lookup<Runner>('find_runner_by_token_hash', hash);
  }
  findUserByEmail(email: string): Promise<User | null> {
    return this.lookup<User>('find_user_by_email', email);
  }
  findUserByNeonSub(sub: string): Promise<User | null> {
    return this.lookup<User>('find_user_by_neon_sub', sub);
  }

  async listOrganizationIds(): Promise<string[]> {
    return (await this.pool.query<{ id: string }>(`SELECT id FROM ${this.s}.list_organization_ids() AS t(id)`)).rows.map((r) => r.id);
  }

  async listActiveOrganizationIds(): Promise<string[]> {
    return (await this.pool.query<{ id: string }>(`SELECT id FROM ${this.s}.list_active_organization_ids() AS t(id)`)).rows.map((r) => r.id);
  }

  /** Uma ida ao servidor: BEGIN, contexto, as instruções e COMMIT. Devolve o resultado da instrução de índice `at`. */
  private async oneShot(organizationId: string, statements: (lit: Lit) => string[], at: number): Promise<pg.QueryResult> {
    const client = await this.pool.connect();
    try {
      const lit: Lit = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(Math.trunc(v)) : client.escapeLiteral(v));
      const results = (await client.query(`BEGIN; SELECT set_config('app.organization_id', ${lit(organizationId)}, true); ${statements(lit).join('; ')}; COMMIT`)) as unknown as pg.QueryResult[];
      return results[2 + at]!;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async eventsAfter(organizationId: string, executionId: string, afterSeq: number): Promise<EventEnvelope[]> {
    const r = await this.oneShot(
      organizationId,
      (lit) => [`SELECT data FROM ${this.s}.events WHERE execution_id = ${lit(executionId)} AND seq > ${lit(afterSeq)} ORDER BY seq`],
      0,
    );
    return r.rows.map((x: { data: EventEnvelope }) => x.data);
  }

  async auditList(organizationId: string, limit: number): Promise<AuditEntry[]> {
    const r = await this.oneShot(organizationId, (lit) => [`SELECT data FROM ${this.s}.audit ORDER BY at DESC LIMIT ${lit(Math.max(1, Math.min(limit, 1000)))}`], 0);
    return r.rows.map((x: { data: AuditEntry }) => x.data);
  }

  async hasClaimable(organizationId: string): Promise<boolean> {
    const r = await this.oneShot(
      organizationId,
      () => [
        `SELECT 1 FROM ${this.s}.records WHERE kind = 'task' AND data->>'status' = 'queued'
           AND (data->>'notBefore' IS NULL OR (data->>'notBefore')::timestamptz <= now()) LIMIT 1`,
      ],
      0,
    );
    return (r.rowCount ?? 0) > 0;
  }

  async touchSession(organizationId: string, idHash: string, lastSeenAt: number, expiresAt: number): Promise<void> {
    await this.oneShot(
      organizationId,
      (lit) => [
        `UPDATE ${this.s}.records SET data = data || jsonb_build_object('lastSeenAt', ${lit(lastSeenAt)}::bigint, 'expiresAt', ${lit(expiresAt)}::bigint)
           WHERE kind = 'session' AND id = ${lit(idHash)}`,
      ],
      0,
    );
  }

  async touchRunner(organizationId: string, runnerId: string, lastSeenAtIso: string): Promise<void> {
    await this.oneShot(
      organizationId,
      (lit) => [`UPDATE ${this.s}.records SET data = data || jsonb_build_object('lastSeenAt', ${lit(lastSeenAtIso)}::text) WHERE kind = 'runner' AND id = ${lit(runnerId)}`],
      0,
    );
  }

  async close(): Promise<void> {
    await this.bus.close?.();
    await this.pool.end();
  }
}
