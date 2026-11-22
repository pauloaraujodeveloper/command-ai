import type { EventEnvelope } from '@command-ai/shared';
import { LocalBus, type EventBus } from './bus.ts';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.ts';
import { createStore, type AuditEntry, type Runner, type Session, type Store, type User } from './store.ts';

/** `read`: fotografia da organização, sem trava e sem gravação. `write`: trava por organização e commit atômico. */
export type UnitMode = 'read' | 'write';

export interface UnitContext {
  store: Store;
  orchestrator: Orchestrator;
}

export interface UnitHandle extends UnitContext {
  /** Grava tudo de uma vez, confirma a transação e só então publica os eventos. */
  commit(): Promise<void>;
  /** Descarta tudo. Pode ser chamado mais de uma vez. */
  rollback(): Promise<void>;
}

/**
 * Acesso aos dados. A API roda o código de negócio (síncrono e testado) sobre uma fatia da organização carregada numa
 * transação: assim vários processos (API, Worker) compartilham o mesmo estado sem divergir.
 */
export interface Repo {
  readonly kind: 'memory' | 'pg';
  readonly bus: EventBus;
  begin(organizationId: string, mode: UnitMode): Promise<UnitHandle>;
  uow<T>(organizationId: string, mode: UnitMode, fn: (ctx: UnitContext) => T | Promise<T>): Promise<T>;

  /* Buscas feitas antes de saber a organização (login, sessão, token de Runner). */
  findSession(idHash: string): Promise<Session | null>;
  findRunnerByTokenHash(hash: string): Promise<Runner | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserByNeonSub(sub: string): Promise<User | null>;

  listOrganizationIds(): Promise<string[]>;
  /** Organizações com execução em andamento: as únicas que a varredura de recuperação precisa visitar. */
  listActiveOrganizationIds(): Promise<string[]>;
  eventsAfter(organizationId: string, executionId: string, afterSeq: number): Promise<EventEnvelope[]>;
  /** As entradas de auditoria mais recentes da organização, da mais nova para a mais antiga. */
  auditList(organizationId: string, limit: number): Promise<AuditEntry[]>;
  /** Há tarefa na fila para esta organização? Barato: evita travar e carregar tudo a cada consulta do Runner. */
  hasClaimable(organizationId: string): Promise<boolean>;
  touchSession(organizationId: string, idHash: string, lastSeenAt: number, expiresAt: number): Promise<void>;
  touchRunner(organizationId: string, runnerId: string, lastSeenAtIso: string): Promise<void>;
  close(): Promise<void>;
}

/** Implementação em memória: um único Store compartilhado. Usada em testes e em demonstração sem banco. */
export class MemoryRepo implements Repo {
  readonly kind = 'memory' as const;
  readonly bus: EventBus;
  readonly store: Store;
  readonly orchestrator: Orchestrator;

  constructor(opts: { orchestrator?: OrchestratorOptions; bus?: EventBus } = {}) {
    this.bus = opts.bus ?? new LocalBus();
    this.store = createStore(undefined, { onEvent: (e) => void this.bus.publish(e) });
    this.orchestrator = new Orchestrator(this.store, opts.orchestrator);
  }

  async begin(): Promise<UnitHandle> {
    return { store: this.store, orchestrator: this.orchestrator, commit: async () => undefined, rollback: async () => undefined };
  }

  async uow<T>(_org: string, _mode: UnitMode, fn: (ctx: UnitContext) => T | Promise<T>): Promise<T> {
    return fn({ store: this.store, orchestrator: this.orchestrator });
  }

  async findSession(idHash: string) {
    return this.store.sessions.get(idHash) ?? null;
  }
  async findRunnerByTokenHash(hash: string) {
    return this.store.runners.filter((r) => r.tokenHash === hash && !r.revoked)[0] ?? null;
  }
  async findUserByEmail(email: string) {
    return this.store.users.filter((u) => u.email === email)[0] ?? null;
  }
  async findUserByNeonSub(sub: string) {
    return this.store.users.filter((u) => u.neonAuthId === sub)[0] ?? null;
  }
  async listOrganizationIds() {
    return this.store.organizations.all().map((o) => o.id);
  }
  async listActiveOrganizationIds() {
    return [...new Set(this.store.executions.filter((e) => e.status === 'running').map((e) => e.organizationId))];
  }
  async eventsAfter(_org: string, executionId: string, afterSeq: number) {
    return this.store.eventsFor(executionId, afterSeq);
  }
  async auditList(organizationId: string, limit: number) {
    return [...this.store.auditFor(organizationId)].reverse().slice(0, limit);
  }
  async hasClaimable(organizationId: string) {
    const now = Date.now();
    return this.store.tasks.filter((t) => t.organizationId === organizationId && t.status === 'queued' && (!t.notBefore || Date.parse(t.notBefore) <= now)).length > 0;
  }
  async touchSession(_org: string, idHash: string, lastSeenAt: number, expiresAt: number) {
    if (this.store.sessions.get(idHash)) this.store.sessions.update(idHash, { lastSeenAt, expiresAt });
  }
  async touchRunner(_org: string, runnerId: string, lastSeenAtIso: string) {
    if (this.store.runners.get(runnerId)) this.store.runners.update(runnerId, { lastSeenAt: lastSeenAtIso });
  }
  async close() {}
}
