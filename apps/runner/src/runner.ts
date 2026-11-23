import { isAbsolute, relative, resolve } from 'node:path';
import { verifyJob, type SignedJob } from '@command-ai/shared/signing';

export interface JobPayload {
  taskId: string;
  executionId: string;
  workspacePath: string;
  prompt: string;
  model: string;
  instructions?: string;
  /** Número da tentativa (1, 2…): volta nos relatórios para o servidor ignorar tentativas antigas. */
  attempt?: number;
  /** De quanto em quanto tempo avisar que a tarefa está viva. Ausente: sem heartbeat. */
  heartbeatMs?: number;
  /** Resultado das tarefas de que esta depende. É texto produzido por outro agente: dado não confiável. */
  upstream?: Array<{ taskId: string; title: string; output: string; commit?: string }>;
  /** Mensagens de outros agentes endereçadas a esta tarefa (dado não confiável). */
  inbox?: Array<{ id?: string; from: string; fromTitle: string; content: string; at: string }>;
  /** As outras tarefas do plano (id, título, situação), para saber a quem escrever. */
  peers?: Array<{ taskId: string; title: string; status: string }>;
}

export interface ExecutorResult {
  output: string;
  /** Commit com o trabalho da tarefa (para as dependentes partirem dele). */
  workspaceCommit?: string;
  usage: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** O que o executor pode usar além do log: relatar uso por interação e pedir aprovação humana. */
export interface ExecutorContext {
  client: RunnerClient;
}

/** `signal` é acionado quando o servidor manda cancelar: o executor deve parar o quanto antes. */
export type Executor = (job: JobPayload, emit: (line: string) => void, signal: AbortSignal, ctx?: ExecutorContext) => Promise<ExecutorResult>;

export interface RunnerClient {
  claim(): Promise<SignedJob | null>;
  log(taskId: string, line: string): Promise<void>;
  heartbeat(taskId: string): Promise<{ ok: boolean; cancel: boolean }>;
  /** Uso de uma interação com o modelo (idempotente por `turn`). `cancel` verdadeiro: o servidor mandou parar (orçamento, cancelamento). */
  usage(taskId: string, body: { turn: number; attempt?: number; usage: ExecutorResult['usage'] }): Promise<{ applied: boolean; cancel: boolean }>;
  /** Conversa entre agentes da mesma execução. */
  sendMessage(taskId: string, body: { attempt?: number; to: string; content: string }): Promise<{ id: string }>;
  readMessages(taskId: string, body: { attempt?: number }): Promise<{ messages: Array<{ id?: string; from: string; fromTitle: string; content: string; at: string }> }>;
  /** Cria subtarefas no plano da execução. O servidor impõe limites e recusa com o motivo. */
  addSubtasks(taskId: string, body: { attempt?: number; tasks: Array<{ id: string; title: string; dependsOn: string[]; risk?: 'low' | 'medium' | 'high' }> }): Promise<{ added: string[] }>;
  requestApproval(taskId: string, req: { attempt?: number; tool: string; summary: string; risk: 'medium' | 'high'; argsPreview?: string }): Promise<{ approvalId: string }>;
  approvalStatus(taskId: string, approvalId: string): Promise<{ status: string; reason?: string } | null>;
  complete(taskId: string, body: ExecutorResult, attempt?: number): Promise<void>;
  fail(taskId: string, reason: string, attempt?: number): Promise<void>;
}

export interface RunnerDeps {
  client: RunnerClient;
  executor: Executor;
  allowedWorkspaces: string[];
  signingKey: string;
}

export type JobOutcome = 'idle' | 'done' | 'failed' | 'rejected' | 'cancelled';

/** Verdadeiro apenas se `candidate` estiver dentro de algum diretório autorizado (após normalizar `..`). */
export function isWorkspaceAllowed(candidate: string, allowed: string[]): boolean {
  if (!candidate || !isAbsolute(candidate.replace(/\\/g, '/')) && !isAbsolute(candidate)) return false;
  const target = resolve(candidate);
  return allowed.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * Processa no máximo um trabalho. O Runner só aceita trabalho assinado pelo backend,
 * só age em diretórios autorizados e nunca executa comandos vindos do painel.
 */
export async function processNextJob(deps: RunnerDeps): Promise<JobOutcome> {
  const signed = await deps.client.claim();
  if (!signed) return 'idle';

  const payload = signed.payload as unknown as JobPayload;
  const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';

  if (!verifyJob(signed, deps.signingKey)) {
    if (taskId) await deps.client.fail(taskId, 'assinatura_invalida');
    return 'rejected';
  }
  const attempt: [] | [number] = typeof payload.attempt === 'number' ? [payload.attempt] : [];
  if (!isWorkspaceAllowed(payload.workspacePath, deps.allowedWorkspaces)) {
    await deps.client.fail(taskId, 'workspace_nao_autorizado', ...attempt);
    return 'rejected';
  }

  // Heartbeat: renova o lease no servidor e recebe o aviso de cancelamento. Erros de rede passageiros são ignorados:
  // se o servidor ficar mudo além do lease, ele mesmo devolve a tarefa à fila e descarta o relatório tardio.
  const controller = new AbortController();
  let cancelled = false;
  const beat =
    typeof payload.heartbeatMs === 'number' && payload.heartbeatMs > 0
      ? setInterval(() => {
          deps.client
            .heartbeat(taskId)
            .then((r) => {
              if (r.cancel && !cancelled) {
                cancelled = true;
                controller.abort();
              }
            })
            .catch(() => undefined);
        }, payload.heartbeatMs)
      : undefined;

  const pending: Promise<void>[] = [];
  try {
    const result = await deps.executor(
      payload,
      (line) => {
        pending.push(deps.client.log(taskId, redactSecrets(line)).catch(() => undefined));
      },
      controller.signal,
      { client: deps.client },
    );
    await Promise.all(pending);
    if (cancelled) return 'cancelled'; // o servidor já encerrou a tarefa: não há o que reportar
    await deps.client.complete(taskId, { ...result, output: redactSecrets(result.output) }, ...attempt);
    return 'done';
  } catch (err) {
    await Promise.all(pending);
    if (cancelled) return 'cancelled';
    await deps.client.fail(taskId, redactSecrets(err instanceof Error ? err.message : 'erro_desconhecido'), ...attempt);
    return 'failed';
  } finally {
    if (beat) clearInterval(beat);
  }
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/g, /(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi];

/** Remove segredos óbvios antes de qualquer log sair da máquina do usuário. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, (m) => (m.includes('=') || m.includes(':') ? m.split(/[=:]/)[0] + '=[REDACTED]' : '[REDACTED]')), text);
}
