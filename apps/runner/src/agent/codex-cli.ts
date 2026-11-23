import { existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { Executor } from '../runner.ts';
import { redactSecrets } from '../runner.ts';
import { childEnv as commonChildEnv, MCP_NOTE, MCP_SERVER, openToolServer, runCliProcess, short } from './cli-common.ts';
import { composeOutput, buildPrompt, openTaskWorkspace } from './executor.ts';
import { buildSystemPrompt } from './loop.ts';
import type { Sandbox } from './sandbox.ts';

/*
 * Executor do Codex (assinatura ChatGPT) como processo filho: `codex exec --json`.
 * VERIFICADO no CLI 0.171.0 (sem login): as flags usadas e os eventos thread.started, turn.started e error.
 * NÃO VERIFICADO contra o CLI real (falta login): os itens (agent_message, file_change, mcp_tool_call…) e turn.completed seguem a documentação.
 * Por isso o executor tem alarmes de segurança em tempo de execução, que valem mesmo que alguma flag mude de significado.
 */

export interface CodexOptions {
  dataDir: string;
  /** Executável do CLI. Padrão: resolvido por `resolveCodexCommand`. */
  command?: { file: string; prefixArgs?: string[] };
  timeoutMs?: number;
  /** Variáveis extras explícitas (só testes). */
  extraEnv?: Record<string, string>;
  maxOutputBytes?: number;
  sandbox?: Sandbox;
  commandTimeoutMs?: number;
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Nome da variável que leva o token do servidor MCP ao Codex (o token nunca vai em argumento). */
export const MCP_TOKEN_ENV = 'CA_MCP_TOKEN';

/**
 * No Windows o npm instala `codex.cmd` (um shim) e o Node não executa .cmd sem shell. Resolve o `codex.js` do pacote ao lado do shim e roda pelo Node.
 * `RUNNER_CODEX_BIN` manda: `.js` roda pelo Node, `.exe` direto, `.cmd` é recusado com a explicação.
 */
export function resolveCodexCommand(env: Record<string, string | undefined> = process.env, platform: string = process.platform): { file: string; prefixArgs?: string[] } {
  const bin = env.RUNNER_CODEX_BIN;
  if (bin) {
    if (/\.(cmd|bat)$/i.test(bin)) throw new Error('RUNNER_CODEX_BIN aponta para um .cmd, que não roda sem shell. Use o codex.js do pacote (…/node_modules/@openai/codex/bin/codex.js) ou o codex.exe.');
    if (/\.(c|m)?js$/i.test(bin)) return { file: process.execPath, prefixArgs: [bin] };
    return { file: bin };
  }
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean)) {
    for (const base of [join(dir, 'node_modules'), join(dir, '..', 'lib', 'node_modules')]) {
      const js = join(base, '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(js)) return { file: process.execPath, prefixArgs: [js] };
    }
  }
  return { file: 'codex' };
}

/** Ambiente do filho: lista de permitidos + onde fica o login (CODEX_HOME). Chaves de API nunca passam (com elas o Codex cobraria da API). */
export function codexChildEnv(src: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  return commonChildEnv(src, extra, ['CODEX_HOME']);
}

/**
 * Argumentos do `codex exec`. Sempre confinado: sandbox do próprio Codex (escrita só no workspace, ou só leitura), SEM a ferramenta de shell
 * dele (comandos só pelas ferramentas do Runner), sem navegador, computador nem apps, sem configuração, regras ou MCP do usuário, sem pedir aprovação
 * (o que exigiria aprovação não roda). O prompt NÃO vai aqui: vai por stdin (`-`).
 */
export function buildCodexArgs(o: { model?: string; canWrite: boolean; cwd: string; mcp?: { url: string; toolTimeoutSec: number } }): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-s', o.canWrite ? 'workspace-write' : 'read-only',
    '--disable', 'shell_tool',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'computer_use',
    '--disable', 'apps',
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-C', o.cwd,
  ];
  if (o.model && o.model !== 'default' && MODEL_RE.test(o.model)) args.push('-m', o.model);
  if (o.mcp) {
    args.push(
      '-c', `mcp_servers.${MCP_SERVER}.url=${JSON.stringify(o.mcp.url)}`,
      '-c', `mcp_servers.${MCP_SERVER}.bearer_token_env_var=${JSON.stringify(MCP_TOKEN_ENV)}`,
      '-c', `mcp_servers.${MCP_SERVER}.tool_timeout_sec=${Math.round(o.mcp.toolTimeoutSec)}`,
    );
  }
  args.push('-');
  return args;
}

interface CxItem {
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  status?: string;
  result?: unknown;
  error?: { message?: string } | null;
  changes?: Array<{ path?: string; kind?: string }>;
}

export function codexExecutor(o: CodexOptions): Executor {
  return async (job, emit, signal, ctx) => {
    if (!ctx) throw new Error('O executor do Codex precisa do contexto do Runner (cliente) para relatar o uso');
    const cmd = o.command ?? resolveCodexCommand();

    const ws = await openTaskWorkspace(job, emit, { dataDir: o.dataDir });
    const canWrite = ws.kind === 'worktree';
    emit(canWrite ? 'Codex: escrita só no worktree, sem shell próprio (comandos só pelas ferramentas do Runner)' : 'Codex: somente leitura');

    let tools: Awaited<ReturnType<typeof openToolServer>> | undefined;
    try {
      tools = await openToolServer({ job, ctx, ws, emit, signal, dataDir: o.dataDir, sandbox: o.sandbox, commandTimeoutMs: o.commandTimeoutMs, approvalPollMs: o.approvalPollMs, approvalTimeoutMs: o.approvalTimeoutMs, writeScopes: job.agent?.writeScopes });
      const hasTools = tools.exposed.length > 0 && !!tools.mcp;
      const approvalMs = o.approvalTimeoutMs ?? 15 * 60_000;
      const extra: Record<string, string> = { ...(o.extraEnv ?? {}), ...(hasTools ? { [MCP_TOKEN_ENV]: tools.token! } : {}) };
      const args = [
        ...(cmd.prefixArgs ?? []),
        ...buildCodexArgs({ model: job.model, canWrite, cwd: ws.root, mcp: hasTools ? { url: tools.mcp!.url, toolTimeoutSec: approvalMs / 1000 + 120 } : undefined }),
      ];
      // O Codex não tem flag de instruções do sistema: as regras de segurança e as instruções do agente vão no começo do prompt.
      const prompt = `${buildSystemPrompt(job.instructions)}${hasTools ? MCP_NOTE : ''}\n\n---\n\n${buildPrompt(job, { messaging: tools.messaging })}`;

      let violation: string | null = null;
      let lastMessage = '';
      let usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | null = null;
      let completed = false;
      let failure: string | null = null;
      let lastError: string | null = null;

      const run = await runCliProcess({
        file: cmd.file,
        args,
        cwd: ws.root,
        env: codexChildEnv(process.env, extra),
        stdin: prompt,
        timeoutMs: o.timeoutMs ?? 30 * 60_000,
        signal,
        maxOutputBytes: o.maxOutputBytes,
        onLine: (line, kill) => {
          let e: { type?: string; item?: CxItem; usage?: typeof usage; error?: { message?: string }; message?: string };
          try {
            e = JSON.parse(line);
          } catch {
            return;
          }
          const stop = (why: string) => {
            if (!violation) violation = why;
            kill();
          };

          if (e.type === 'turn.completed') {
            completed = true;
            usage = e.usage ?? null;
          } else if (e.type === 'turn.failed') failure = e.error?.message ?? 'o turno falhou';
          else if (e.type === 'error') {
            const m = String(e.message ?? '');
            if (/^reconnecting/i.test(m)) emit(`Codex: ${short(m, 160)}`);
            else lastError = m;
          } else if ((e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') && e.item) {
            const it = e.item;
            const done = e.type === 'item.completed';
            if (it.type === 'agent_message' && done && it.text) {
              lastMessage = it.text;
              emit(`Agente: ${short(it.text, 300)}`);
            } else if (it.type === 'command_execution') stop('O Codex tentou executar um comando próprio (shell); interrompido. Comandos só pelas ferramentas do Runner.');
            else if (it.type === 'web_search') stop('O Codex tentou fazer uma busca na web; interrompido.');
            else if (it.type === 'mcp_tool_call') {
              if (it.server !== MCP_SERVER) stop('O Codex tentou usar outro servidor MCP; interrompido.');
              else if (e.type === 'item.started') emit(`Ferramenta ${it.tool} ${short(it.arguments, 120)}`);
              else if (done) emit(`Resultado ${it.tool}: ${it.status === 'completed' ? 'ok' : 'erro'} — ${short(it.error?.message ?? it.result, 100)}`);
            } else if (it.type === 'file_change') {
              for (const c of it.changes ?? []) {
                const abs = resolve(ws.root, String(c.path ?? ''));
                const rel = relative(ws.root, abs);
                if (rel === '..' || rel.startsWith('..') || isAbsolute(rel)) return stop('O Codex tentou alterar um arquivo fora do worktree; interrompido.');
                if (done) emit(`Ferramenta ${c.kind ?? 'alterar'} ${short(rel, 120)}`);
              }
            }
          }
        },
      });

      if (violation) throw new Error(violation);
      if (run.aborted) throw new Error('cancelado');
      if (run.timedOut) throw new Error('Tempo limite da tarefa excedido');
      if (run.spawnError === 'enoent') throw new Error(`O CLI do Codex não foi encontrado (${cmd.file}). Instale com "npm i -g @openai/codex", rode "codex login" com a sua conta ChatGPT, ou defina RUNNER_CODEX_BIN.`);
      if (run.spawnError) throw new Error(`Não foi possível iniciar o Codex: ${redactSecrets(run.spawnError).slice(0, 200)}`);
      if (run.tooBig) throw new Error('O Codex produziu saída grande demais e foi interrompido');
      if (failure) throw new Error(redactSecrets(failure).slice(0, 500));

      if (!completed) {
        const detail = redactSecrets(lastError ?? run.stderr.trim()).slice(-300);
        if (lastError && /401|unauthorized|bearer|not logged in|login/i.test(lastError)) {
          throw new Error(`O Codex não está autenticado. Rode "codex login" na máquina do Runner, com a sua conta ChatGPT. Detalhe: ${detail}`);
        }
        throw new Error(lastError ? redactSecrets(lastError).slice(0, 400) : run.code ? `O Codex saiu com código ${run.code}${detail ? `: ${detail}` : ''}` : 'O Codex terminou sem resultado final (formato de saída inesperado?)');
      }

      // Uso do Codex → relato por turno com o "modelo" assinatura (preço zero). Em `input_tokens` o cache já está incluído.
      type Used = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number };
      let unreported = null as Used | null;
      const u = usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | null;
      if (u) {
        const cached = u.cached_input_tokens ?? 0;
        const used: Used = { model: 'assinatura', inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached), outputTokens: u.output_tokens ?? 0 };
        if (cached) used.cacheReadTokens = cached;
        try {
          await ctx.client.usage(job.taskId, { turn: 1, attempt: job.attempt, usage: used });
        } catch {
          unreported = used;
        }
      }

      const fin = await ws.finalize({ writeScopes: job.agent?.writeScopes });
      const output = composeOutput(ws, fin, lastMessage);
      emit('Concluído pelo Codex');
      return { output, workspaceCommit: fin.commit, usage: unreported ?? { model: 'assinatura', inputTokens: 0, outputTokens: 0 } };
    } finally {
      await tools?.cleanup();
      await ws.cleanup().catch(() => undefined);
    }
  };
}
