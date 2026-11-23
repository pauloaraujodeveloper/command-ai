import { execFileSync, spawn } from 'node:child_process';
import type { Executor } from '../runner.ts';
import { redactSecrets } from '../runner.ts';
import { composeOutput, buildPrompt, openTaskWorkspace } from './executor.ts';
import { buildSystemPrompt } from './loop.ts';

type Env = Record<string, string | undefined>;

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
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Argumentos do `claude -p`. Sempre confinado: modo restrito (sem ferramentas que executam código nem rede, arquivos só no
 * diretório de trabalho), sem MCP, sem pedidos de permissão (o que pediria é negado) e só as ferramentas de arquivo.
 * O prompt NÃO vai aqui: vai por stdin.
 */
export function buildClaudeArgs(o: { model?: string; effort?: string; canWrite: boolean; appendSystem: string }): string[] {
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
  if (o.canWrite) args.push('--allowedTools', 'Write,Edit');
  if (o.model && MODEL_RE.test(o.model)) args.push('--model', o.model);
  if (o.effort && EFFORTS.has(o.effort)) args.push('--effort', o.effort);
  args.push('--append-system-prompt', o.appendSystem);
  return args;
}

/** Só o que o CLI precisa para achar o login e a rede. Nada do ambiente do Runner (tokens, chaves, bancos) passa. */
const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)',
  'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'LANG', 'LC_ALL', 'TERM',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR',
];

export function childEnv(src: Env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (src[k] !== undefined && src[k] !== '') out[k] = src[k]!;
  // Com chave de API no ambiente o CLI cobraria da API em vez de usar a assinatura: nunca passa (nem por engano em ENV_ALLOW).
  delete out.ANTHROPIC_API_KEY;
  return { ...out, ...extra };
}

const short = (v: unknown, n = 160) => redactSecrets(typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).replace(/\s+/g, ' ').slice(0, n);

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

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* já encerrado */
  }
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
    emit(canWrite ? 'Claude Code: só ferramentas de arquivo, confinado ao worktree (sem comandos, sem rede, sem MCP)' : 'Claude Code: somente leitura (sem Write nem Edit)');

    try {
      const args = [...(cmd.prefixArgs ?? []), ...buildClaudeArgs({ model: job.model === 'default' ? undefined : job.model, canWrite, appendSystem: buildSystemPrompt(job.instructions) })];
      const prompt = buildPrompt(job, { messaging: false });

      const run = await new Promise<{ result: CliResult | null; code: number | null; stderr: string; timedOut: boolean; aborted: boolean; tooBig: boolean; spawnError: string | null }>((resolve) => {
        const child = spawn(cmd.file, args, { cwd: ws.root, env: childEnv(process.env, o.extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let result: CliResult | null = null;
        let stderr = '';
        let buf = '';
        let bytes = 0;
        let timedOut = false;
        let aborted = false;
        let tooBig = false;
        let spawnError: string | null = null;
        const toolNames = new Map<string, string>();
        const maxBytes = o.maxOutputBytes ?? 50 * 1024 * 1024;

        const handle = (line: string) => {
          if (!line.trim() || line.length > 1_000_000) return;
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
          }
          else if (e.type === 'result') result = e;
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, o.timeoutMs ?? 30 * 60_000);
        const onAbort = () => {
          aborted = true;
          killTree(child.pid);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (d: Buffer) => {
          bytes += d.length;
          if (bytes > maxBytes) {
            tooBig = true;
            killTree(child.pid);
            return;
          }
          buf += d.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            handle(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
          if (buf.length > 2_000_000) buf = ''; // linha gigante sem quebra: descarta
        });
        child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2000)));
        child.stdin.on('error', () => undefined); // processo que fecha o stdin cedo
        child.stdin.end(prompt);

        child.on('error', (err: NodeJS.ErrnoException) => {
          spawnError = err.code === 'ENOENT' ? 'enoent' : err.message;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve({ result, code: null, stderr, timedOut, aborted, tooBig, spawnError });
        });
        child.on('close', (code) => {
          if (spawnError) return;
          if (buf.trim()) handle(buf);
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve({ result, code, stderr, timedOut, aborted, tooBig, spawnError });
        });
      });

      if (run.aborted) throw new Error('cancelado');
      if (run.timedOut) throw new Error('Tempo limite da tarefa excedido');
      if (run.spawnError === 'enoent') throw new Error(`O CLI do Claude Code não foi encontrado (${cmd.file}). Instale o Claude Code e faça login, ou defina RUNNER_CLAUDE_BIN com o caminho do executável.`);
      if (run.spawnError) throw new Error(`Não foi possível iniciar o Claude Code: ${redactSecrets(run.spawnError).slice(0, 200)}`);
      if (run.tooBig) throw new Error('O Claude Code produziu saída grande demais e foi interrompido');

      // Uso do CLI → o mesmo relato por turno do agente por API, com o "modelo" assinatura (preço zero: o plano é mensal).
      type Used = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
      let unreported = null as Used | null;
      if (run.result?.usage) {
        const u = run.result.usage;
        const usage: Used = { model: 'assinatura', inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
        if (u.cache_read_input_tokens) usage.cacheReadTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) usage.cacheWriteTokens = u.cache_creation_input_tokens;
        try {
          await ctx.client.usage(job.taskId, { turn: 1, attempt: job.attempt, usage });
        } catch {
          unreported = usage; // vai junto no relatório final
        }
      }

      if (!run.result) {
        const tail = redactSecrets(run.stderr.trim()).slice(-400);
        throw new Error(run.code ? `O Claude Code saiu com código ${run.code}${tail ? `: ${tail}` : ''}` : 'O Claude Code terminou sem resultado final (formato de saída inesperado?)');
      }
      if (run.result.is_error) throw new Error(redactSecrets(String(run.result.result ?? 'erro desconhecido do Claude Code')).slice(0, 500));

      if (typeof run.result.total_cost_usd === 'number') emit(`Custo equivalente de API (só referência; a assinatura não cobra por token): US$ ${run.result.total_cost_usd.toFixed(4)}`);
      const fin = await ws.finalize();
      const output = composeOutput(ws, fin, String(run.result.result ?? ''));
      emit(`Concluído em ${run.result.num_turns ?? '?'} turno(s) do Claude Code`);
      return { output, workspaceCommit: fin.commit, usage: unreported ?? { model: 'assinatura', inputTokens: 0, outputTokens: 0 } };
    } finally {
      await ws.cleanup().catch(() => undefined);
    }
  };
}
