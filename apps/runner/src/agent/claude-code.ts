import type { Executor } from '../runner.ts';
import { redactSecrets } from '../runner.ts';
import { childEnv as commonChildEnv, MCP_NOTE, MCP_SERVER, openToolServer, runCliProcess, short } from './cli-common.ts';
import { composeOutput, buildPrompt, openTaskWorkspace } from './executor.ts';
import { buildSystemPrompt } from './loop.ts';
import type { Sandbox } from './sandbox.ts';

export interface ClaudeCodeOptions {
  /** Pasta de dados do Runner (worktrees e patches). */
  dataDir: string;
  /** Executável do CLI. Padrão: `claude` (no PATH). `prefixArgs` serve a testes (um script Node no lugar do CLI). */
  command?: { file: string; prefixArgs?: string[] };
  timeoutMs?: number;
  /** Variáveis extras explícitas para o CLI (só testes). Nada do ambiente do Runner passa sem estar na lista de permitidos. */
  extraEnv?: Record<string, string>;
  /** Teto do que o CLI pode escrever na saída padrão. */
  maxOutputBytes?: number;
  /**
   * Sandbox Docker dos comandos. Com ele (ou com subtarefas e mensagens no cliente), o Runner abre um servidor MCP local e
   * dá ao Claude Code as ferramentas do Runner: comandos, apagar arquivo, subtarefas e mensagens, com a MESMA política e aprovação humana do agente por API.
   */
  sandbox?: Sandbox;
  commandTimeoutMs?: number;
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
}

export { MCP_SERVER };

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Argumentos do `claude -p`. Sempre confinado: modo restrito (sem ferramentas que executam código nem rede, arquivos só no
 * diretório de trabalho), sem outros servidores MCP, sem pedidos de permissão (o que pediria é negado) e só as ferramentas de arquivo
 * (mais as do Runner por MCP, quando houver). O prompt NÃO vai aqui: vai por stdin.
 */
export function buildClaudeArgs(o: { model?: string; effort?: string; canWrite: boolean; appendSystem: string; mcpConfigPath?: string; mcpTools?: string[] }): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--restricted',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--permission-prompts', 'none',
    '--permission-mode', 'dontAsk',
    '--tools', o.canWrite ? 'Read,Write,Edit,Glob,Grep' : 'Read,Glob,Grep',
  ];
  const allowed = [...(o.canWrite ? ['Write', 'Edit'] : []), ...(o.mcpTools ?? []).map((t) => `mcp__${MCP_SERVER}__${t}`)];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  // O servidor MCP do Runner (local, com token da tarefa). O config vai por ARQUIVO: o token não aparece na lista de processos.
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
  if (o.model && MODEL_RE.test(o.model)) args.push('--model', o.model);
  if (o.effort && EFFORTS.has(o.effort)) args.push('--effort', o.effort);
  args.push('--append-system-prompt', o.appendSystem);
  return args;
}

/** Ambiente do filho: lista de permitidos (o login do Claude Code fica em CLAUDE_CONFIG_DIR ou no perfil do usuário). */
export function childEnv(src: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  return commonChildEnv(src, extra, ['CLAUDE_CONFIG_DIR']);
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface CliResult {
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * Executor que usa o Claude Code já instalado e autenticado na máquina (a assinatura do plano mensal).
 * O Command AI nunca toca no token do login: só aciona o CLI oficial, confinado ao worktree da tarefa.
 */
export function claudeCodeExecutor(o: ClaudeCodeOptions): Executor {
  const cmd = o.command ?? { file: process.env.RUNNER_CLAUDE_BIN || 'claude' };
  return async (job, emit, signal, ctx) => {
    if (!ctx) throw new Error('O executor do Claude Code precisa do contexto do Runner (cliente) para relatar o uso');

    const ws = await openTaskWorkspace(job, emit, { dataDir: o.dataDir });
    const canWrite = ws.kind === 'worktree';
    emit(canWrite ? 'Claude Code: arquivos confinados ao worktree; sem shell nem rede próprios (comandos só pelas ferramentas do Runner)' : 'Claude Code: somente leitura (sem Write nem Edit)');

    let tools: Awaited<ReturnType<typeof openToolServer>> | undefined;
    try {
      tools = await openToolServer({ job, ctx, ws, emit, signal, dataDir: o.dataDir, sandbox: o.sandbox, commandTimeoutMs: o.commandTimeoutMs, approvalPollMs: o.approvalPollMs, approvalTimeoutMs: o.approvalTimeoutMs, writeScopes: job.agent?.writeScopes, writeConfigFile: true });
      const hasTools = tools.exposed.length > 0;
      // Uma chamada pode esperar a decisão humana por minutos: o CLI não pode desistir antes do prazo de aprovação.
      const extra = hasTools ? { ...(o.extraEnv ?? {}), MCP_TOOL_TIMEOUT: String((o.approvalTimeoutMs ?? 15 * 60_000) + 120_000) } : (o.extraEnv ?? {});
      const args = [
        ...(cmd.prefixArgs ?? []),
        ...buildClaudeArgs({
          model: job.model === 'default' ? undefined : job.model,
          canWrite,
          appendSystem: buildSystemPrompt(job.instructions) + (hasTools ? MCP_NOTE : ''),
          mcpConfigPath: tools.configPath,
          mcpTools: tools.exposed.map((t) => t.name),
        }),
      ];

      let result: CliResult | null = null;
      const toolNames = new Map<string, string>();
      const run = await runCliProcess({
        file: cmd.file,
        args,
        cwd: ws.root,
        env: childEnv(process.env, extra),
        stdin: buildPrompt(job, { messaging: tools.messaging }),
        timeoutMs: o.timeoutMs ?? 30 * 60_000,
        signal,
        maxOutputBytes: o.maxOutputBytes,
        onLine: (line) => {
          let e: { type?: string; subtype?: string; model?: string; message?: { content?: Block[] }; rate_limit_info?: unknown } & CliResult;
          try {
            e = JSON.parse(line);
          } catch {
            return; // linha que não é JSON: ignorada
          }
          if (e.type === 'system' && e.subtype === 'init') emit(`Claude Code: modelo ${short(e.model ?? 'padrão', 60)}`);
          else if (e.type === 'assistant') {
            for (const b of e.message?.content ?? []) {
              if (b.type === 'text' && b.text?.trim()) emit(`Agente: ${short(b.text, 300)}`);
              else if (b.type === 'tool_use' && b.name) {
                if (b.id) toolNames.set(b.id, b.name);
                emit(`Ferramenta ${b.name} ${short(b.input, 120)}`);
              }
            }
          } else if (e.type === 'user') {
            for (const b of e.message?.content ?? []) {
              if (b.type === 'tool_result') emit(`Resultado ${toolNames.get(b.tool_use_id ?? '') ?? 'ferramenta'}: ${b.is_error ? 'erro' : 'ok'} — ${short(b.content, 100)}`);
            }
          } else if (e.type === 'rate_limit_event') {
            // Formato observado no CLI real: { status, resetsAt (segundos), rateLimitType, utilization (0 a 1) }.
            const i = (e.rate_limit_info ?? {}) as { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number };
            const parts = [i.status, typeof i.utilization === 'number' ? `${Math.round(i.utilization * 100)}% usado` : null, typeof i.resetsAt === 'number' ? `renova em ${new Date(i.resetsAt * 1000).toLocaleString('pt-BR')}` : null].filter(Boolean);
            emit(`Aviso de limite de uso do plano (${short(i.rateLimitType ?? 'plano', 30)}): ${parts.join(', ') || short(e.rate_limit_info ?? {}, 120)}`);
          } else if (e.type === 'result') result = e;
        },
      });

      if (run.aborted) throw new Error('cancelado');
      if (run.timedOut) throw new Error('Tempo limite da tarefa excedido');
      if (run.spawnError === 'enoent') throw new Error(`O CLI do Claude Code não foi encontrado (${cmd.file}). Instale o Claude Code e faça login, ou defina RUNNER_CLAUDE_BIN com o caminho do executável.`);
      if (run.spawnError) throw new Error(`Não foi possível iniciar o Claude Code: ${redactSecrets(run.spawnError).slice(0, 200)}`);
      if (run.tooBig) throw new Error('O Claude Code produziu saída grande demais e foi interrompido');

      const final = result as CliResult | null;
      // Uso do CLI → o mesmo relato por turno do agente por API, com o "modelo" assinatura (preço zero: o plano é mensal).
      type Used = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
      let unreported = null as Used | null;
      if (final?.usage) {
        const u = final.usage;
        const usage: Used = { model: 'assinatura', inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
        if (u.cache_read_input_tokens) usage.cacheReadTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) usage.cacheWriteTokens = u.cache_creation_input_tokens;
        try {
          await ctx.client.usage(job.taskId, { turn: 1, attempt: job.attempt, usage });
        } catch {
          unreported = usage; // vai junto no relatório final
        }
      }

      if (!final) {
        const tail = redactSecrets(run.stderr.trim()).slice(-400);
        throw new Error(run.code ? `O Claude Code saiu com código ${run.code}${tail ? `: ${tail}` : ''}` : 'O Claude Code terminou sem resultado final (formato de saída inesperado?)');
      }
      if (final.is_error) throw new Error(redactSecrets(String(final.result ?? 'erro desconhecido do Claude Code')).slice(0, 500));

      if (typeof final.total_cost_usd === 'number') emit(`Custo equivalente de API (só referência; a assinatura não cobra por token): US$ ${final.total_cost_usd.toFixed(4)}`);
      const fin = await ws.finalize({ writeScopes: job.agent?.writeScopes });
      const output = composeOutput(ws, fin, String(final.result ?? ''));
      emit(`Concluído em ${final.num_turns ?? '?'} turno(s) do Claude Code`);
      return { output, workspaceCommit: fin.commit, usage: unreported ?? { model: 'assinatura', inputTokens: 0, outputTokens: 0 } };
    } finally {
      await tools?.cleanup();
      await ws.cleanup().catch(() => undefined);
    }
  };
}
