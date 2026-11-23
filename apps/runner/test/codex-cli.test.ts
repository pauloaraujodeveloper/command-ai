import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCodexArgs, codexChildEnv, codexExecutor, resolveCodexCommand } from '../src/agent/codex-cli.ts';
import type { ExecutorContext, JobPayload, RunnerClient } from '../src/runner.ts';

const git = promisify(execFile);
const FAKE = resolve(import.meta.dirname, 'fixtures/fake-codex.cjs');
let repo: string;
let data: string;
let dump: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ca-cx-repo-'));
  data = mkdtempSync(join(tmpdir(), 'ca-cx-data-'));
  dump = join(data, 'dump.json');
  await git('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'original\n');
  await git('git', ['add', '-A'], { cwd: repo });
  await git('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const job = (over: Partial<JobPayload> = {}): JobPayload => ({ taskId: 'task-1', executionId: 'exec-1', workspacePath: repo, prompt: 'Crie uma nota', model: 'default', provider: 'codex', attempt: 1, ...over });
const readDump = () => JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string>; envKeys: string[]; stdin: string; pid: number };
const mcpOut = () => join(data, 'mcp-out.json');
const readOut = () => JSON.parse(readFileSync(mcpOut(), 'utf8')) as { cfg: Record<string, unknown>; tokenSeen: boolean; init: { protocolVersion: string }; list: string[]; calls: Array<{ name: string; result: { isError?: boolean; content?: Array<{ text: string }>; code?: number } }> };

const richCtx = (approval: { status: string; reason?: string } = { status: 'approved' }) => {
  const client = {
    usage: vi.fn(async (_t: string, _b: unknown) => ({ applied: true, cancel: false })),
    requestApproval: vi.fn(async (_t: string, _r: unknown) => ({ approvalId: 'ap1' })),
    approvalStatus: vi.fn(async () => approval),
    addSubtasks: vi.fn(async (_t: string, _b: unknown) => ({ added: ['s1'] })),
    sendMessage: vi.fn(async (_t: string, _b: unknown) => ({ id: 'm1' })),
    readMessages: vi.fn(async () => ({ messages: [] })),
  };
  return { client, context: { client: client as unknown as RunnerClient } as ExecutorContext };
};
const plainCtx = () => {
  const client = { usage: vi.fn(async (_t: string, _b: unknown) => ({ applied: true, cancel: false })) };
  return { client, context: { client: client as unknown as RunnerClient } as ExecutorContext };
};
const fakeSandbox = () => {
  const runs: Array<Record<string, unknown>> = [];
  return { runs, sandbox: { async run(o: Record<string, unknown>) { runs.push(o); return { exitCode: 0, stdout: 'oi\n', stderr: '', timedOut: false, aborted: false, truncated: false, durationMs: 5 }; } } as never };
};
const mk = (mode: string, over: Partial<Parameters<typeof codexExecutor>[0]> = {}, env: Record<string, string> = {}) =>
  codexExecutor({ dataDir: data, command: { file: process.execPath, prefixArgs: [FAKE] }, timeoutMs: 20_000, approvalPollMs: 5, approvalTimeoutMs: 1_000, extraEnv: { FAKE_MODE: mode, FAKE_DUMP: dump, ...env }, ...over });
const go = (e: ReturnType<typeof mk>, ctx = plainCtx().context, j = job(), lines: string[] = []) => e(j, (l) => lines.push(l), new AbortController().signal, ctx);

describe('buildCodexArgs: o Codex sempre roda confinado', () => {
  const base = { canWrite: true, cwd: '/w' };
  it('exec em JSON, sem shell próprio, sem navegador/computador/apps, sem configuração do usuário, sem aprovação interativa', () => {
    const a = buildCodexArgs(base);
    const s = a.join(' ');
    expect(a[0]).toBe('exec');
    for (const f of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) expect(a).toContain(f);
    expect(s).toContain('-s workspace-write');
    for (const feat of ['shell_tool', 'browser_use', 'browser_use_external', 'computer_use', 'apps']) expect(s).toContain(`--disable ${feat}`);
    expect(s).toContain('approval_policy="never"');
    expect(s).toContain('-C /w');
    expect(a.at(-1)).toBe('-'); // o prompt vem por stdin
  });
  it('NUNCA usa os modos perigosos', () => {
    const s = buildCodexArgs({ ...base, mcp: { url: 'http://127.0.0.1:1/mcp', toolTimeoutSec: 100 } }).join(' ');
    expect(s).not.toMatch(/dangerously|danger-full-access|bypass/);
  });
  it('workspace somente leitura usa o sandbox read-only', () => {
    expect(buildCodexArgs({ ...base, canWrite: false }).join(' ')).toContain('-s read-only');
  });
  it('MCP do Runner: URL e nome da variável do token (o token em si não vai nos argumentos)', () => {
    const a = buildCodexArgs({ ...base, mcp: { url: 'http://127.0.0.1:5555/mcp', toolTimeoutSec: 1020 } });
    const s = a.join(' ');
    expect(s).toContain('mcp_servers.command_ai.url="http://127.0.0.1:5555/mcp"');
    expect(s).toContain('mcp_servers.command_ai.bearer_token_env_var="CA_MCP_TOKEN"');
    expect(s).toContain('mcp_servers.command_ai.tool_timeout_sec=1020');
  });
  it('modelo só entra se for um nome simples (e "default" significa o padrão da conta)', () => {
    expect(buildCodexArgs({ ...base, model: 'gpt-5-codex' }).join(' ')).toContain('-m gpt-5-codex');
    for (const bad of ['default', '', '--dangerously-bypass-approvals-and-sandbox', 'a b', 'x;rm']) expect(buildCodexArgs({ ...base, model: bad }).join(' ')).not.toMatch(/ -m /);
  });
});

describe('resolveCodexCommand: o shim .cmd do npm não pode ser executado sem shell', () => {
  it('RUNNER_CODEX_BIN com .js roda pelo Node; com .cmd explica; com .exe usa direto', () => {
    expect(resolveCodexCommand({ RUNNER_CODEX_BIN: 'C:\\x\\codex.js' }, 'win32')).toEqual({ file: process.execPath, prefixArgs: ['C:\\x\\codex.js'] });
    expect(() => resolveCodexCommand({ RUNNER_CODEX_BIN: 'C:\\x\\codex.cmd' }, 'win32')).toThrow(/\.cmd/);
    expect(resolveCodexCommand({ RUNNER_CODEX_BIN: 'C:\\x\\codex.exe' }, 'win32')).toEqual({ file: 'C:\\x\\codex.exe' });
  });
  it('acha o codex.js do pacote npm global ao lado do shim no PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-cx-npm-'));
    try {
      mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'codex.cmd'), '@echo off');
      writeFileSync(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
      const r = resolveCodexCommand({ PATH: [join(dir, 'nada'), dir].join(process.platform === 'win32' ? ';' : ':') }, process.platform);
      expect(r.file).toBe(process.execPath);
      expect(r.prefixArgs?.[0]).toBe(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('sem nada disso, usa "codex" do PATH', () => {
    expect(resolveCodexCommand({ PATH: '' }, 'linux')).toEqual({ file: 'codex' });
  });
});

describe('codexChildEnv', () => {
  it('mantém o login (CODEX_HOME) e remove chaves de API e segredos do Runner', () => {
    const env = codexChildEnv({ PATH: '/bin', CODEX_HOME: 'C:\\h', OPENAI_API_KEY: 'sk-oai', CODEX_API_KEY: 'sk-cx', ANTHROPIC_API_KEY: 'sk-ant', COMMAND_AI_RUNNER_TOKEN: 'car_x', JOB_SIGNING_KEY: 'k', DATABASE_URL: 'postgres://x' });
    expect(env.CODEX_HOME).toBe('C:\\h');
    expect(env.PATH).toBe('/bin');
    const t = JSON.stringify(env);
    for (const secret of ['sk-oai', 'sk-cx', 'sk-ant', 'car_x', 'postgres://']) expect(t).not.toContain(secret);
  });
});

describe('codexExecutor com um Codex falso (mesmo formato JSONL)', () => {
  it('roda no worktree, entrega patch e commit, relata o uso (cache separado) e não toca na pasta da pessoa', async () => {
    const { client, context } = plainCtx();
    const lines: string[] = [];
    process.env.COMMAND_AI_RUNNER_TOKEN = 'car_nao_pode_vazar';
    process.env.OPENAI_API_KEY = 'sk-nao-pode-vazar-1234567890';
    let r;
    try {
      r = await go(mk('ok'), context, job(), lines);
    } finally {
      delete process.env.COMMAND_AI_RUNNER_TOKEN;
      delete process.env.OPENAI_API_KEY;
    }
    expect(r.output).toContain('Feito: criei NOTA.md.');
    expect(r.output).toMatch(/1 arquivo/);
    expect(r.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(repo, 'NOTA.md'))).toBe(false);
    expect((await git('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');

    const d = readDump();
    expect(d.cwd).toContain('worktrees');
    expect(d.stdin).toContain('Crie uma nota');
    expect(d.argv.join(' ')).not.toContain('Crie uma nota');
    expect(d.argv).toContain('--ignore-user-config');
    expect(JSON.stringify(d.env)).not.toContain('nao-pode-vazar');
    expect(d.envKeys).not.toContain('OPENAI_API_KEY');

    expect(lines.some((l) => /Agente: Feito/.test(l))).toBe(true);
    expect(client.usage).toHaveBeenCalledWith('task-1', { turn: 1, attempt: 1, usage: { model: 'assinatura', inputTokens: 3000, outputTokens: 300, cacheReadTokens: 9000 } });
    expect(r.usage).toMatchObject({ model: 'assinatura', inputTokens: 0, outputTokens: 0 });
  });

  it('o prompt leva as regras de segurança, as instruções do agente e o resultado das tarefas anteriores como dado', async () => {
    await go(mk('ok'), plainCtx().context, job({ instructions: 'Seja breve.', upstream: [{ taskId: 'a', title: 'Antes', output: 'resultado de A' }] }));
    const d = readDump();
    expect(d.stdin).toContain('Seja breve.');
    expect(d.stdin).toMatch(/DADOS/);
    expect(d.stdin).toContain('resultado de A');
  });

  it('pasta sem Git: somente leitura (sandbox read-only) e o relatório diz isso', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ca-cx-plain-'));
    try {
      writeFileSync(join(plain, 'x.txt'), 'x');
      const r = await go(mk('ok'), plainCtx().context, job({ workspacePath: plain }));
      expect(readDump().argv.join(' ')).toContain('-s read-only');
      expect(r.output).toMatch(/somente leitura/i);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('linhas soltas e eventos desconhecidos não derrubam', async () => {
    const r = await go(mk('garbage'));
    expect(r.output).toContain('Feito');
  });

  it('erro de login (401): falha com a mensagem útil, sem tentar de novo para sempre', async () => {
    const e = (await go(mk('autherror')).catch((x: Error) => x)) as Error;
    expect(e.message).toMatch(/401|login/i);
    expect(e.message).toMatch(/codex login/i); // diz o que fazer
  });

  it('turno que falha (cota do plano): a mensagem do Codex chega', async () => {
    await expect(go(mk('fail'))).rejects.toThrow(/Limite de uso do plano/);
  });

  it('terminar sem turn.completed é erro claro; CLI ausente também', async () => {
    await expect(go(mk('noresult'))).rejects.toThrow(/sem resultado final/i);
    const absent = codexExecutor({ dataDir: data, command: { file: 'codex-que-nao-existe-xyz' }, timeoutMs: 5_000 });
    await expect(go(absent)).rejects.toThrow(/não foi encontrado|RUNNER_CODEX_BIN/i);
  });

  it('tempo esgotado e cancelamento matam o processo', async () => {
    await expect(go(mk('hang', { timeoutMs: 600 }))).rejects.toThrow(/tempo/i);
    await new Promise((r) => setTimeout(r, 400));
    expect(() => process.kill(readDump().pid, 0)).toThrow();

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await expect(mk('hang')(job(), () => undefined, ac.signal, plainCtx().context)).rejects.toThrow(/cancelado/i);
    await new Promise((r) => setTimeout(r, 400));
    expect(() => process.kill(readDump().pid, 0)).toThrow();
  });

  it('alarme de segurança: o Codex tentou usar o próprio shell, buscar na web, outro servidor MCP ou escrever fora: o processo é morto e a tarefa falha', async () => {
    const cases: Array<[string, RegExp]> = [
      ['shell', /comando próprio|shell/i],
      ['websearch', /busca na web|web/i],
      ['othermcp', /outro servidor|MCP/i],
      ['outside', /fora do worktree/i],
    ];
    for (const [mode, re] of cases) {
      const e = (await go(mk(mode)).catch((x: Error) => x)) as Error;
      expect(e, mode).toBeInstanceOf(Error);
      expect(e.message, mode).toMatch(re);
    }
    // e nada ficou de resultado na pasta da pessoa
    expect(readdirSync(repo).sort()).toEqual(['.git', 'a.txt']);
  });

  it('falha sem mudanças limpa o worktree', async () => {
    await go(mk('fail')).catch(() => undefined);
    expect(existsSync(join(data, 'worktrees')) ? readdirSync(join(data, 'worktrees')) : []).toEqual([]);
  });
});

describe('codexExecutor com as ferramentas do Runner por MCP', () => {
  const run = (calls: unknown[], over: Partial<Parameters<typeof codexExecutor>[0]> = {}, approval?: { status: string; reason?: string }) => {
    const sb = fakeSandbox();
    const c = richCtx(approval);
    const e = mk('mcp', { sandbox: sb.sandbox, ...over }, { FAKE_MCP_OUT: mcpOut(), FAKE_MCP_CALLS: JSON.stringify(calls) });
    return { ...sb, ...c, result: go(e, c.context) };
  };

  it('configura o servidor MCP por -c, passa o token só por variável de ambiente e oferece as ferramentas', async () => {
    const r = run([]);
    await r.result;
    const out = readOut();
    expect([...out.list].sort()).toEqual(['delete_file', 'plan_subtasks', 'read_messages', 'run_command', 'send_message']);
    expect(out.tokenSeen).toBe(true);
    expect(out.cfg.bearer_token_env_var).toBe('CA_MCP_TOKEN');
    const d = readDump();
    const token = d.env.CA_MCP_TOKEN!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(d.argv.join(' ')).not.toContain(token); // não aparece na lista de processos
    expect(d.argv.join(' ')).not.toMatch(/dangerously|danger-full-access/);
  });

  it('run_command roda no sandbox (somente leitura, sem rede); rede ou escrita pedem aprovação; negado não executa', async () => {
    const a = run([{ name: 'run_command', args: { command: 'echo oi' } }]);
    await a.result;
    expect(a.runs[0]).toMatchObject({ command: 'echo oi', writable: false, network: false });
    expect(a.client.requestApproval).not.toHaveBeenCalled();

    const b = run([{ name: 'run_command', args: { command: 'curl x', network: true } }], {}, { status: 'rejected', reason: 'não' });
    await b.result;
    expect(b.client.requestApproval).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'run_command', risk: 'high' }));
    expect(b.runs).toHaveLength(0);
    expect(readOut().calls[0]!.result.isError).toBe(true);
  });

  it('apagar arquivo exige aprovação e vale no worktree', async () => {
    const r = run([{ name: 'delete_file', args: { path: 'a.txt' } }]);
    const out = await r.result;
    expect(r.client.requestApproval).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'delete_file' }));
    expect(out.output).toMatch(/-original/);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('original\n');
  });

  it('sem sandbox, run_command nem é oferecida; ao fim o servidor fecha', async () => {
    const r = run([], { sandbox: undefined });
    await r.result;
    const out = readOut();
    expect(out.list).not.toContain('run_command');
    await expect(fetch(String(out.cfg.url), { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
