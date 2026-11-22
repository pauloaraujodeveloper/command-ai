import { randomUUID } from 'node:crypto';
import type { EventEnvelope, EventType, ExecutionStatus, RiskLevel, Role, TaskStatus } from '@command-ai/shared';

/**
 * Armazenamento do MVP: em memória, atrás de tabelas tipadas.
 * Todo registro de negócio carrega organizationId (isolamento por organização).
 * O esquema Prisma/PostgreSQL equivalente está em prisma/schema.prisma e entra na etapa 5.
 */

/** Destino opcional de persistência (PostgreSQL). O store continua síncrono; o sink grava em fila. */
export interface Sink {
  upsert(kind: string, row: { id: string; organizationId?: string }): void;
  /** `organizationId` é o contexto de isolamento (RLS) em que a remoção acontece. */
  remove(kind: string, id: string, organizationId: string | null): void;
  event(event: EventEnvelope, organizationId: string | null): void;
  audit(entry: AuditEntry): void;
}

/** Organização dona do registro: a própria linha para `organization`, o campo `organizationId` nos demais. */
export function organizationIdOf(kind: string, row: { id: string; organizationId?: string }): string | null {
  return kind === 'organization' ? row.id : (row.organizationId ?? null);
}

export class Table<T extends { id: string }> {
  private rows = new Map<string, T>();
  constructor(
    readonly kind = '',
    private sink?: Sink,
  ) {}
  insert(row: T): T {
    this.rows.set(row.id, row);
    this.sink?.upsert(this.kind, row as T & { organizationId?: string });
    return row;
  }
  /** Carrega um registro já persistido, sem gravar de novo. */
  hydrate(row: T): void {
    this.rows.set(row.id, row);
  }
  get(id: string): T | undefined {
    return this.rows.get(id);
  }
  update(id: string, patch: Partial<T>): T {
    const current = this.rows.get(id);
    if (!current) throw new Error(`Registro não encontrado: ${id}`);
    const next = { ...current, ...patch };
    this.rows.set(id, next);
    this.sink?.upsert(this.kind, next as T & { organizationId?: string });
    return next;
  }
  delete(id: string): void {
    const row = this.rows.get(id) as (T & { organizationId?: string }) | undefined;
    this.rows.delete(id);
    this.sink?.remove(this.kind, id, row ? organizationIdOf(this.kind, row) : null);
  }
  filter(fn: (row: T) => boolean): T[] {
    return [...this.rows.values()].filter(fn);
  }
  all(): T[] {
    return [...this.rows.values()];
  }
}

export interface Organization {
  id: string;
  name: string;
}
export interface User {
  id: string;
  /** Identidade no Neon Auth (claim sub), quando a conta entrou por lá. */
  neonAuthId?: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
  passwordHash: string;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  /** Último passo TOTP aceito: um código nunca vale duas vezes. */
  lastTotpStep?: number;
  createdAt: string;
}
export interface Session {
  id: string; // sha256 do token
  userId: string;
  organizationId: string;
  /** Sessão sem segundo fator: só alcança /me, a configuração de MFA e o logout. */
  limited?: boolean;
  expiresAt: number;
  lastSeenAt: number;
}
export interface Provider {
  id: string;
  organizationId: string;
  kind: 'anthropic' | 'openai' | 'ollama' | 'simulated';
  name: string;
  apiKeyRef: string | null;
  defaultModel: string;
  createdAt: string;
}
export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  instructions: string;
  providerKind: Provider['kind'];
  model: string;
  fallbackModels?: string[];
  budgetUsd: number;
}
export interface Project {
  id: string;
  organizationId: string;
  name: string;
  workspacePath: string;
}
export interface Execution {
  id: string;
  organizationId: string;
  projectId: string;
  agentId: string;
  goal: string;
  status: ExecutionStatus;
  budgetUsd: number;
  costUsd: number;
  costUnknown: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  failureReason?: string;
  planVersion: number;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Prazo máximo da execução em andamento; passado, a varredura a encerra. */
  deadlineAt?: string;
  /** Último número de sequência de evento emitido. Vive na execução para valer entre processos (a escrita é serializada por organização). */
  eventSeq?: number;
  budgetWarned?: boolean;
}
export interface Task {
  id: string; // `${executionId}:${planTaskId}`
  executionId: string;
  organizationId: string;
  planId: string;
  title: string;
  agentId: string;
  dependsOn: string[]; // ids completos de tarefas
  risk: RiskLevel;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  approved: boolean;
  output?: string;
  error?: string;
  runnerId?: string;
  /** Até quando a tarefa em execução vale sem heartbeat. Vencido, a varredura a devolve à fila. */
  leaseExpiresAt?: string;
  lastHeartbeatAt?: string;
  /** Espera progressiva: a tarefa só pode ser reivindicada a partir deste instante. */
  notBefore?: string;
  /** Último turno de uso do modelo já contabilizado nesta tentativa (torna o envio idempotente). */
  lastUsageTurn?: number;
  position: number;
}
export interface Approval {
  id: string;
  organizationId: string;
  executionId: string;
  taskId: string;
  status: 'pending' | 'approved' | 'rejected';
  /** `task`: aprovação para uma tarefa de risco alto começar (padrão). `tool`: o agente pede para usar uma ferramenta de risco no meio da tarefa. */
  kind?: 'task' | 'tool';
  tool?: { name: string; summary: string; risk: 'medium' | 'high'; argsPreview?: string };
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}
export interface Runner {
  id: string;
  organizationId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revoked: boolean;
}
export interface AuditEntry {
  id: string;
  organizationId: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

type Listener = (event: EventEnvelope) => void;

export interface StoreHooks {
  /** Chamado a cada evento emitido (para publicar para quem está assistindo ao vivo). */
  onEvent?: (event: EventEnvelope) => void;
}

export function createStore(sink?: Sink, hooks: StoreHooks = {}) {
  const events = new Map<string, EventEnvelope[]>();
  const listeners = new Map<string, Set<Listener>>();
  const audit: AuditEntry[] = [];

  const store = {
    organizations: new Table<Organization>('organization', sink),
    users: new Table<User>('user', sink),
    sessions: new Table<Session>('session', sink),
    providers: new Table<Provider>('provider', sink),
    agents: new Table<Agent>('agent', sink),
    projects: new Table<Project>('project', sink),
    executions: new Table<Execution>('execution', sink),
    tasks: new Table<Task>('task', sink),
    approvals: new Table<Approval>('approval', sink),
    runners: new Table<Runner>('runner', sink),

    hydrateEvents(list: EventEnvelope[]): void {
      for (const e of list) {
        const bucket = events.get(e.executionId) ?? [];
        bucket.push(e);
        events.set(e.executionId, bucket);
      }
    },
    hydrateAudit(list: AuditEntry[]): void {
      audit.push(...list);
    },

    emit(executionId: string, taskId: string | null, type: EventType, payload: Record<string, unknown>): EventEnvelope {
      const list = events.get(executionId) ?? [];
      const exec = store.executions.get(executionId);
      // O contador na execução vale entre processos (numa unidade de trabalho a lista de eventos não é carregada).
      const seq = Math.max(exec?.eventSeq ?? 0, list.length) + 1;
      if (exec) store.executions.update(executionId, { eventSeq: seq });
      const event: EventEnvelope = {
        id: randomUUID(),
        seq,
        executionId,
        taskId,
        type,
        version: 1,
        ts: new Date().toISOString(),
        payload,
      };
      list.push(event);
      events.set(executionId, list);
      sink?.event(event, exec?.organizationId ?? null);
      hooks.onEvent?.(event);
      for (const fn of listeners.get(executionId) ?? []) fn(event);
      return event;
    },

    eventsFor(executionId: string, afterSeq = 0): EventEnvelope[] {
      return (events.get(executionId) ?? []).filter((e) => e.seq > afterSeq);
    },

    subscribe(executionId: string, fn: Listener): () => void {
      const set = listeners.get(executionId) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(executionId, set);
      return () => {
        set.delete(fn);
      };
    },

    /** Registro somente de acréscimo. */
    audit(entry: Omit<AuditEntry, 'id' | 'at'>): void {
      const full: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry };
      audit.push(full);
      sink?.audit(full);
    },
    auditFor(organizationId: string): readonly AuditEntry[] {
      return audit.filter((a) => a.organizationId === organizationId);
    },
  };
  return store;
}

export type Store = ReturnType<typeof createStore>;
