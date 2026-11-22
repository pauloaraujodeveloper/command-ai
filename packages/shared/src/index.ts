import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Estados e máquina de estados                                        */
/* ------------------------------------------------------------------ */

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const TASK_STATUSES = [
  'pending', // aguardando dependências
  'queued', // pronta para um Runner
  'waiting_approval', // aguardando decisão humana
  'running',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'draft',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['queued', 'waiting_approval', 'cancelled'],
  queued: ['running', 'cancelled'],
  waiting_approval: ['queued', 'failed', 'cancelled'],
  running: ['done', 'failed', 'cancelled', 'queued'], // queued = nova tentativa
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export const isTerminalTask = (s: TaskStatus) => s === 'done' || s === 'failed' || s === 'cancelled';

/* ------------------------------------------------------------------ */
/* Preços (tabela configurável; valores são marcadores a confirmar)    */
/* ------------------------------------------------------------------ */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Leitura de cache de prompt. Ausente: cobra como entrada normal (nunca subestima). */
  cacheReadPerMTok?: number;
  /** Escrita de cache (TTL de 5 min). Ausente: 1,25x a entrada, como a documentação da Anthropic descreve. */
  cacheWritePerMTok?: number;
  currency: 'USD';
}

/**
 * Preços por milhão de tokens da API da Anthropic, conforme a tabela da documentação oficial de 2026-11-03.
 * Haiku 5.5: preço para prompts de até 100K tokens (acima disso é maior). Esta tabela é o padrão: a PRD prevê
 * uma tabela por organização com vigência, que ainda não existe. Revise ao menos a cada mudança de preço publicada.
 */
export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5-2': { inputPerMTok: 8, outputPerMTok: 40, cacheReadPerMTok: 0.2, cacheWritePerMTok: 10, currency: 'USD' },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, currency: 'USD' },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5, currency: 'USD' },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, currency: 'USD' },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, currency: 'USD' },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5, currency: 'USD' },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, currency: 'USD' },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, currency: 'USD' },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, currency: 'USD' },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, currency: 'USD' },
};

export interface Usage {
  model: string;
  /** Tokens de entrada não vindos do cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Custo em USD, ou null quando o modelo não tem preço (nunca estimado em silêncio). */
export function costFor(
  model: string,
  usage: Omit<Usage, 'model'>,
  table: Record<string, ModelPrice> = PRICING,
): number | null {
  const price = table[model];
  if (!price) return null;
  const perM = 1_000_000;
  const cacheRead = (usage.cacheReadTokens ?? 0) * (price.cacheReadPerMTok ?? price.inputPerMTok);
  const cacheWrite = (usage.cacheWriteTokens ?? 0) * (price.cacheWritePerMTok ?? price.inputPerMTok * 1.25);
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok + cacheRead + cacheWrite) / perM;
}

/* ------------------------------------------------------------------ */
/* Eventos (envelope versionado com número de sequência)               */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = [
  'execution.state_changed',
  'task.state_changed',
  'log.appended',
  'approval.requested',
  'approval.decided',
  'usage.updated',
  'alert.raised',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope<P = Record<string, unknown>> {
  id: string;
  seq: number;
  executionId: string;
  taskId: string | null;
  type: EventType;
  version: 1;
  ts: string;
  payload: P;
}

/* ------------------------------------------------------------------ */
/* Schemas de entrada da API (fonte única, Zod)                        */
/* ------------------------------------------------------------------ */

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  orgName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(12, 'A senha precisa ter ao menos 12 caracteres').max(200),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/, 'O código tem 6 dígitos')
    .optional(),
});

export const mfaActivateSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const providerSchema = z.object({
  kind: z.enum(['anthropic', 'openai', 'ollama', 'simulated']),
  name: z.string().trim().min(1).max(80),
  /** Nome da variável de ambiente do Runner que guarda a chave. A chave em si nunca é armazenada. */
  apiKeyRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Use o nome da variável de ambiente, por exemplo ANTHROPIC_API_KEY')
    .optional(),
  defaultModel: z.string().trim().min(1).max(80),
});

export const agentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(8000),
  providerKind: z.enum(['anthropic', 'openai', 'ollama', 'simulated']),
  model: z.string().trim().min(1).max(80),
  fallbackModels: z.array(z.string().trim().min(1).max(80)).max(5).default([]),
  budgetUsd: z.number().positive().max(10_000).default(5),
});

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  workspacePath: z.string().trim().min(1).max(500),
});

export const planTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  title: z.string().trim().min(1).max(200),
  agentId: z.string().min(1),
  dependsOn: z.array(z.string()).max(50),
  risk: z.enum(RISK_LEVELS),
});
export type PlanTaskInput = z.infer<typeof planTaskSchema>;

export const createExecutionSchema = z.object({
  goal: z.string().trim().min(5).max(4000),
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  budgetUsd: z.number().positive().max(10_000).optional(),
});

export const updatePlanSchema = z.object({ tasks: z.array(planTaskSchema).min(1).max(50) });

export const decideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(500).optional(),
});

const usageSchema = z.object({
  model: z.string().min(1).max(80),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});

/** Uso de uma interação com o modelo, enviado enquanto a tarefa roda. `turn` torna o envio idempotente. */
export const runnerUsageSchema = z.object({
  turn: z.number().int().positive(),
  attempt: z.number().int().positive().optional(),
  usage: usageSchema,
});

/** Pedido de aprovação humana para uma chamada de ferramenta de risco. */
export const toolApprovalRequestSchema = z.object({
  attempt: z.number().int().positive().optional(),
  tool: z.string().trim().min(1).max(60),
  summary: z.string().trim().min(1).max(500),
  risk: z.enum(['medium', 'high']),
  argsPreview: z.string().max(4000).optional(),
});

export const runnerReportSchema = z.object({
  /** Tentativa a que o relatório se refere; relatórios de tentativas antigas são ignorados. */
  attempt: z.number().int().positive().optional(),
  line: z.string().max(10_000).optional(),
  output: z.string().max(200_000).optional(),
  reason: z.string().max(2000).optional(),
  usage: usageSchema.optional(),
  /** Commit (SHA-1 completo) com o trabalho da tarefa no repositório do Runner. Só hexadecimal: nunca nome, opção ou caminho. */
  workspaceCommit: z.string().regex(/^[0-9a-f]{40}$/, 'commit inválido').optional(),
});

export const ROLES = ['owner', 'admin', 'developer', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
