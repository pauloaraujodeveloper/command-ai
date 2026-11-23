import type { WorkspaceKind } from './tools.ts';

export type Risk = 'medium' | 'high';
export type Decision = { action: 'allow' } | { action: 'approve'; risk: Risk; summary: string };

export interface ToolApprovalRequest {
  attempt?: number;
  tool: string;
  summary: string;
  risk: Risk;
  argsPreview?: string;
}

/** Parte do cliente do Runner de que o portão precisa (separada para facilitar o teste). */
export interface ApprovalClient {
  requestApproval(taskId: string, req: ToolApprovalRequest): Promise<{ approvalId: string }>;
  approvalStatus(taskId: string, approvalId: string): Promise<{ status: string; reason?: string } | null>;
}

const READ_ONLY = new Set(['list_dir', 'read_file', 'search_files']);

/** Uma linha limpa para a pessoa ler. Texto vindo do modelo nunca chega cru à tela de aprovação. */
// eslint-disable-next-line no-control-regex
const clean = (s: unknown, max: number) => String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const field = (input: unknown, key: string): unknown => (input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined);

/**
 * Decide se uma chamada de ferramenta passa direto ou precisa de aprovação humana.
 * Regra de ouro: o que o modelo escreve (inclusive texto lido de arquivos, que pode ser uma injeção de prompt)
 * nunca concede permissão. A política olha só para a ferramenta, o tipo de workspace e as flags de risco.
 */
export function decide(tool: string, input: unknown, kind: WorkspaceKind): Decision {
  if (READ_ONLY.has(tool)) return { action: 'allow' };

  if (tool === 'write_file' || tool === 'edit_file') {
    if (kind !== 'direct') return { action: 'allow' }; // worktree isolado: vira patch para revisão
    return { action: 'approve', risk: 'medium', summary: `${tool === 'write_file' ? 'Escrever' : 'Editar'} direto na pasta do projeto: ${clean(field(input, 'path'), 200)}` };
  }

  if (tool === 'delete_file') {
    return { action: 'approve', risk: 'medium', summary: `Apagar o arquivo ${clean(field(input, 'path'), 200)}` };
  }

  if (tool === 'plan_subtasks') {
    const tasks = Array.isArray(field(input, 'tasks')) ? (field(input, 'tasks') as unknown[]) : [];
    const titles = tasks.map((t) => clean(field(t, 'title'), 60)).filter(Boolean).join('; ');
    const high = tasks.some((t) => field(t, 'risk') === 'high');
    return { action: 'approve', risk: high ? 'high' : 'medium', summary: `Criar ${tasks.length} subtarefa(s) no plano: ${titles}`.slice(0, 400) };
  }

  if (tool === 'run_command') {
    const cmd = clean(field(input, 'command'), 300);
    if (input === null || typeof input !== 'object') return { action: 'approve', risk: 'high', summary: 'Executar comando com entrada inválida' };
    if (field(input, 'network') === true) return { action: 'approve', risk: 'high', summary: `Executar comando COM ACESSO À REDE: ${cmd}` };
    if (field(input, 'writable') === true) return { action: 'approve', risk: 'medium', summary: `Executar comando com escrita no workspace: ${cmd}` };
    return { action: 'allow' }; // sandbox, sem rede, workspace somente leitura
  }

  return { action: 'approve', risk: 'high', summary: `Ferramenta desconhecida: ${clean(tool, 60)}` };
}

export interface AwaitOptions {
  signal: AbortSignal;
  pollMs?: number;
  /** Sem decisão neste prazo, a chamada é negada. Nunca se aprova por silêncio. */
  timeoutMs?: number;
}

export type ApprovalOutcome =
  | { status: 'approved' }
  | { status: 'rejected'; reason?: string }
  | { status: 'timeout' }
  | { status: 'cancelled' }
  | { status: 'closed' }
  | { status: 'error'; message: string };

/** Registra o pedido no servidor e espera a decisão humana. Qualquer falha ou dúvida resulta em NÃO executar. */
export async function awaitApproval(client: ApprovalClient, taskId: string, req: ToolApprovalRequest, opts: AwaitOptions): Promise<ApprovalOutcome> {
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);

  let approvalId: string;
  try {
    ({ approvalId } = await client.requestApproval(taskId, req));
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'falha ao pedir aprovação' };
  }

  while (!opts.signal.aborted) {
    if (Date.now() >= deadline) return { status: 'timeout' };
    try {
      const s = await client.approvalStatus(taskId, approvalId);
      if (s === null) return { status: 'closed' };
      if (s.status === 'approved') return { status: 'approved' };
      if (s.status === 'rejected') return { status: 'rejected', reason: s.reason };
      if (s.status !== 'pending') return { status: 'closed' };
    } catch {
      /* falha passageira: tenta de novo até o prazo */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  return { status: 'cancelled' };
}
