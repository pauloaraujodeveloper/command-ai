import { redactSecrets } from '../runner.ts';
import type { AgentClient } from './loop.ts';
import { awaitApproval, decide } from './policy.ts';
import type { Sandbox } from './sandbox.ts';
import { runTool, TOOLS, validateInput, type WorkspaceInfo } from './tools.ts';

/** A espera por aprovação foi interrompida por cancelamento (ou tempo total). */
export class CancelledError extends Error {
  constructor() {
    super('cancelado');
  }
}

export interface GuardEnv {
  workspace: WorkspaceInfo;
  sandbox?: Sandbox;
  client: AgentClient;
  taskId: string;
  attempt?: number;
  emit: (line: string) => void;
  signal: AbortSignal;
  commandTimeoutMs?: number;
  /** Onde este agente pode escrever (ausente: sem restrição). */
  writeScopes?: string[];
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
  /** Ferramentas oferecidas neste ambiente (as demais são recusadas, mesmo que o modelo as peça). */
  offered: Set<string>;
  planning: boolean;
  messaging: boolean;
}

export const short = (v: unknown, n = 160) => redactSecrets(typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).replace(/\s+/g, ' ').slice(0, n);

/**
 * Executa UMA chamada de ferramenta com todas as guardas: ferramenta oferecida, entrada válida, política de risco,
 * aprovação humana quando exigida (prazo, falha e dúvida = nega) e execução com limites. Usada tanto pelo laço do agente por API
 * quanto pelo servidor MCP que dá comandos ao Claude Code: a mesma política vale nos dois, venha o pedido de onde vier.
 */
export async function runGuarded(name: string, input: unknown, env: GuardEnv): Promise<{ content: string; isError: boolean }> {
  const fail = (content: string) => ({ content, isError: true });
  if (!env.offered.has(name)) return fail(`Ferramenta não disponível neste ambiente: ${name}`);
  const def = TOOLS[name]!;
  const invalid = validateInput(def.spec, input);
  if (invalid) return fail(`INVALID_INPUT: ${invalid}`);

  const decision = decide(name, input, env.workspace.kind);
  if (decision.action === 'approve') {
    env.emit(`Aguardando aprovação humana: ${name} (${decision.summary.slice(0, 120)})`);
    const outcome = await awaitApproval(
      env.client,
      env.taskId,
      { attempt: env.attempt, tool: name, summary: decision.summary, risk: decision.risk, argsPreview: short(input, 4000) },
      { signal: env.signal, pollMs: env.approvalPollMs, timeoutMs: env.approvalTimeoutMs },
    );
    if (outcome.status === 'cancelled') throw new CancelledError();
    if (outcome.status === 'rejected') {
      env.emit(`Aprovação negada para ${name}`);
      return fail(`Negado pelo usuário${outcome.reason ? `: ${outcome.reason}` : ''}. A operação NÃO foi executada.`);
    }
    if (outcome.status !== 'approved') {
      env.emit(`Aprovação não concedida para ${name} (${outcome.status})`);
      return fail(`Aprovação não concedida (${outcome.status}). A operação NÃO foi executada.`);
    }
    env.emit(`Aprovado: ${name}`);
  }

  env.emit(`Ferramenta ${name} ${short(input, 120)}`);
  const c = env.client;
  const r = await runTool(name, input, {
    workspace: env.workspace,
    signal: env.signal,
    sandbox: env.sandbox,
    commandTimeoutMs: env.commandTimeoutMs,
    writeScopes: env.writeScopes,
    planSubtasks: env.planning ? (tasks) => c.addSubtasks!(env.taskId, { attempt: env.attempt, tasks }) : undefined,
    sendMessage: env.messaging ? async (to, content) => void (await c.sendMessage!(env.taskId, { attempt: env.attempt, to, content })) : undefined,
    readMessages: env.messaging ? async () => (await c.readMessages!(env.taskId, { attempt: env.attempt })).messages : undefined,
  });
  env.emit(`Resultado ${name}: ${r.isError ? 'erro' : 'ok'} — ${short(r.content, 100)}`);
  return { content: r.content, isError: !!r.isError };
}
