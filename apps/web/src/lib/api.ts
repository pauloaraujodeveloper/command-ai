import type { EventEnvelope, ExecutionStatus, RiskLevel, Role, TaskStatus } from '@command-ai/shared';

export type { EventEnvelope, ExecutionStatus, RiskLevel, Role, TaskStatus };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'x-command-ai': '1', 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const p = (data ?? {}) as { code?: string; detail?: string; errors?: Array<{ message: string }> };
    const extra = p.errors?.length ? ` ${p.errors.map((e) => e.message).join(' ')}` : '';
    throw new ApiError(res.status, p.code ?? 'error', `${p.detail ?? 'Erro inesperado.'}${extra}`);
  }
  return data as T;
}

/* ---------------- tipos de resposta ---------------- */

export interface Me {
  user: { id: string; name: string; email: string; role: Role; mfaEnabled: boolean; organizationId: string };
  organization: { id: string; name: string };
  /** Sessão limitada: o painel só mostra a tela de ativação do MFA. */
  mfaEnrollmentRequired?: boolean;
}

export interface Execution {
  id: string;
  projectId: string;
  agentId: string;
  goal: string;
  status: ExecutionStatus;
  budgetUsd: number;
  costUsd: number;
  costUnknown: boolean;
  inputTokens: number;
  outputTokens: number;
  failureReason?: string;
  createdAt: string;
  progress?: { done: number; total: number };
}

export interface Task {
  id: string;
  planId: string;
  title: string;
  agentId: string;
  dependsOn: string[];
  risk: RiskLevel;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  output?: string;
  error?: string;
  position: number;
}

export interface Approval {
  id: string;
  executionId: string;
  taskId: string;
  status: 'pending' | 'approved' | 'rejected';
  /** 'task': aprovação para iniciar a tarefa. 'tool': aprovação de uma chamada de ferramenta durante a execução. */
  kind?: 'task' | 'tool';
  tool?: { name: string; summary: string; risk: 'medium' | 'high'; argsPreview?: string };
  requestedAt: string;
  decidedAt?: string;
  reason?: string;
  goal?: string;
  task?: { id: string; title: string; risk: RiskLevel };
  agent?: { id: string; name: string; model: string };
  project?: { id: string; name: string; workspacePath: string };
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  providerKind: string;
  model: string;
  budgetUsd: number;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
}

export interface Provider {
  id: string;
  kind: string;
  name: string;
  apiKeyRef: string | null;
  defaultModel: string;
  capabilities: Record<string, boolean>;
}

export interface RunnerRow {
  id: string;
  name: string;
  online: boolean;
  revoked: boolean;
  lastSeenAt?: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  instructions: string;
  model: string;
}

export interface Dashboard {
  attention: Array<{ kind: 'approval' | 'failure' | 'budget' | 'runner_offline'; title: string; detail: string; to: string }>;
  numbers: { running: number; succeeded24h: number; failed24h: number; costUsd24h: number };
  recent: Execution[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
}
