import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeArgs, childEnv, claudeCodeExecutor } from '../src/agent/claude-code.ts';
import type { ExecutorContext, JobPayload, RunnerClient } from '../src/runner.ts';

const git = promisify(execFile);
const FAKE = resolve(import.meta.dirname, 'fixtures/fake-claude.cjs');
let repo: string;
let data: string;
let dump: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ca-cc-repo-'));
  data = mkdtempSync(join(tmpdir(), 'ca-cc-data-'));
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

const job = (over: Partial<JobPayload> = {}): JobPayload => ({ taskId: 'task-1', executionId: 'exec-1', workspacePath: repo, prompt: 'Crie uma nota', model: 'haiku', provider: 'claude_code', attempt: 1, ...over });
const ctx = () => {
  const client = { usage: vi.fn(async (_t: string, _b: unknown) => ({ applied: true, cancel: false })) } as unknown as RunnerClient;
  return { client, context: { client } as ExecutorContext };
};
const exec = (mode: string, over: Partial<Parameters<typeof claudeCodeExecutor>[0]> = {}) =>
  claudeCodeExecutor({ dataDir: data, command: { file: process.execPath, prefixArgs: [FAKE] }, timeoutMs: 20_000, extraEnv: { FAKE_MODE: mode, FAKE_DUMP: dump }, ...over });
const readDump = () => JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[]; cwd: string; envKeys: string[]; env: Record<string, string>; stdin: string; pid: number };

describe('buildClaudeArgs: o CLI sempre roda confinado', () => {
  const base = { canWrite: true, appendSystem: 'regras' };
  it('modo restrito, sem MCP, sem prompts de permissão, só as ferramentas de arquivo', () => {
    const a = buildClaudeArgs(base);
    const s = a.join(' ');
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--verbose']) expect(a).toContain(flag);
    expect(s).toContain('--output-format stream-json');
    expect(s).toContain('--permission-prompts none');
    expect(s).toContain('--permission-mode dontAsk');
    expect(s).toContain('--tools Read,Write,Edit,Glob,Grep');
    expect(s).toContain('--allowedTools Write,Edit');
    expect(s).toContain('--append-system-prompt regras');
  });
  it('NUNCA pede para pular permissões, nem libera shell ou rede', () => {
    const s = buildClaudeArgs(base).join(' ');
    expect(s).not.toMatch(/dangerously|bypassPermissions|--add-dir|Bash|PowerShell|WebFetch|WebSearch|--mcp-config/);
  });
  it('workspace somente leitura: sem Write nem Edit', () => {
    const s = buildClaudeArgs({ ...base, canWrite: false }).join(' ');
    expect(s).toContain('--tools Read,Glob,Grep');
    expect(s).not.toMatch(/Write|Edit|--allowedTools/);
  });
  it('modelo e esforço só entram se forem nomes simples; o prompt nunca vai nos argumentos', () => {
    expect(buildClaudeArgs({ ...base, model: 'haiku', effort: 'low' }).join(' ')).toContain('--model haiku');
    expect(buildClaudeArgs({ ...base, effort: 'low' }).join(' ')).toContain('--effort low');
    for (const bad of ['--dangerously-skip-permissions', 'a b', 'x;rm -rf', '', '-p']) {
      expect(buildClaudeArgs({ ...base, model: bad }).join(' ')).not.toContain('--model');
    }
    expect(buildClaudeArgs({ ...base, effort: 'ultra' }).join(' ')).not.toContain('--effort');
  });
});

describe('childEnv: nada do ambiente do Runner passa para o CLI', () => {
  it('lista de permitidos; remove chaves, tokens e URLs de banco; remove ANTHROPIC_API_KEY (senão cobraria da API)', () => {
    const env = childEnv({
      PATH: '/bin',
      USERPROFILE: 'C:\\Users\\x',
      APPDATA: 'C:\\x\\AppData',
      ANTHROPIC_API_KEY: 'sk-ant-segredo',
      OPENAI_API_KEY: 'sk-oai',
      DEEPSEEK_API_KEY: 'sk-ds',
      COMMAND_AI_RUNNER_TOKEN: 'car_segredo',
      JOB_SIGNING_KEY: 'chave-de-assinatura',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://x',
      RUNNER_ALLOWED_WORKSPACES: 'C:\\w',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.USERPROFILE).toBe('C:\\Users\\x');
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY']));
    const text = JSON.stringify(env);
    for (const secret of ['sk-ant-segredo', 'sk-oai', 'sk-ds', 'car_segredo', 'chave-de-assinatura', 'postgres://', 'redis://']) expect(text).not.toContain(secret);
  });
  it('variáveis extras explícitas (testes) entram; ausentes são ignoradas', () => {
    expect(childEnv({ PATH: 'p' }, { FAKE_MODE: 'ok' }).FAKE_MODE).toBe('ok');
    expect(childEnv({}).PATH).toBeUndefined();
  });
});

describe('claudeCodeExecutor com um CLI falso (mesmo formato stream-json do real)', () => {
  it('roda no worktree, entrega o patch e o commit, relata o uso e não toca na pasta da pessoa', async () => {
    const { client, context } = ctx();
    const lines: string[] = [];
    process.env.COMMAND_AI_RUNNER_TOKEN = 'car_nao_pode_vazar';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-nao-pode-vazar';
    let r;
    try {
      r = await exec('ok')(job(), (l) => lines.push(l), new AbortController().signal, context);
    } finally {
      delete process.env.COMMAND_AI_RUNNER_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }

    expect(r.output).toContain('Feito: criei NOTA.md.');
    expect(r.output).toMatch(/1 arquivo/);
    expect(r.output).toContain('NOTA.md');
    expect(r.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(repo, 'NOTA.md'))).toBe(false);
    expect((await git('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');

    const d = readDump();
    expect(d.cwd).not.toBe(repo); // roda no worktree
    expect(d.cwd).toContain('worktrees');
    expect(d.stdin).toContain('Crie uma nota'); // o prompt foi por stdin
    expect(d.argv.join(' ')).not.toContain('Crie uma nota');
    expect(d.argv).toContain('--restricted');
    expect(d.argv.join(' ')).toContain('--model haiku');
    const leaked = JSON.stringify(d.env);
    expect(leaked).not.toContain('nao-pode-vazar');
    expect(d.envKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(d.envKeys).not.toContain('COMMAND_AI_RUNNER_TOKEN');

    expect(lines.some((l) => /Ferramenta Write/.test(l))).toBe(true);
    expect(lines.some((l) => /Resultado Write: ok/.test(l))).toBe(true);
    expect(lines.some((l) => /equivalente de API/i.test(l))).toBe(true);

    // uso relatado uma vez, na assinatura (preço zero), com os campos de cache do CLI
    expect(client.usage).toHaveBeenCalledOnce();
    expect(client.usage).toHaveBeenCalledWith('task-1', { turn: 1, attempt: 1, usage: { model: 'assinatura', inputTokens: 4, outputTokens: 300, cacheReadTokens: 8000, cacheWriteTokens: 2000 } });
    expect(r.usage).toMatchObject({ model: 'assinatura', inputTokens: 0, outputTokens: 0 });
  });

  it('o prompt leva o resultado das tarefas anteriores como dado e NÃO promete ferramentas que o CLI não tem', async () => {
    const { context } = ctx();
    await exec('ok')(job({ upstream: [{ taskId: 'a', title: 'Antes', output: 'resultado de A' }], peers: [{ taskId: 'b', title: 'Depois', status: 'pending' }] }), () => undefined, new AbortController().signal, context);
    const d = readDump();
    expect(d.stdin).toContain('resultado de A');
    expect(d.stdin).toMatch(/não confiáveis/);
    expect(d.stdin).not.toContain('send_message');
  });

  it('pasta sem Git: somente leitura (sem Write/Edit) e o relatório diz isso', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ca-cc-plain-'));
    try {
      writeFileSync(join(plain, 'x.txt'), 'x');
      const { context } = ctx();
      const r = await exec('readonly')(job({ workspacePath: plain }), () => undefined, new AbortController().signal, context);
      expect(readDump().argv.join(' ')).toContain('--tools Read,Glob,Grep');
      expect(r.output).toMatch(/somente leitura/i);
      expect(readdirSync(plain)).toEqual(['x.txt']);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('linhas que não são JSON e eventos desconhecidos são ignorados sem derrubar', async () => {
    const r = await exec('garbage')(job(), () => undefined, new AbortController().signal, ctx().context);
    expect(r.output).toContain('Feito');
  });

  it('aviso de limite de uso do plano aparece no log', async () => {
    const lines: string[] = [];
    await exec('ratelimit')(job(), (l) => lines.push(l), new AbortController().signal, ctx().context);
    expect(lines.some((l) => /limite de uso/i.test(l))).toBe(true);
  });

  it('resultado com erro (por exemplo cota esgotada): a tarefa falha com a mensagem do CLI', async () => {
    await expect(exec('error_result')(job(), () => undefined, new AbortController().signal, ctx().context)).rejects.toThrow(/Limite de uso da assinatura/);
  });

  it('falha do processo: mensagem com o fim do stderr, sem segredos', async () => {
    const err = (await exec('crash')(job(), () => undefined, new AbortController().signal, ctx().context).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/código 2|saiu/i);
    expect(err.message).toContain('falha interna');
    expect(err.message).not.toContain('abcdefghijklmnop1234567890');
  });

  it('terminar sem evento final é erro claro', async () => {
    await expect(exec('noresult')(job(), () => undefined, new AbortController().signal, ctx().context)).rejects.toThrow(/sem resultado final/i);
  });

  it('CLI inexistente: erro que diz como configurar', async () => {
    const e = claudeCodeExecutor({ dataDir: data, command: { file: 'claude-que-nao-existe-xyz' }, timeoutMs: 5_000 });
    await expect(e(job(), () => undefined, new AbortController().signal, ctx().context)).rejects.toThrow(/não foi encontrado|RUNNER_CLAUDE_BIN/i);
  });

  it('tempo esgotado: mata o processo e falha com mensagem de tempo', async () => {
    const p = exec('hang', { timeoutMs: 600 })(job(), () => undefined, new AbortController().signal, ctx().context);
    await expect(p).rejects.toThrow(/tempo/i);
    await new Promise((r) => setTimeout(r, 400));
    const { pid } = readDump();
    expect(() => process.kill(pid, 0)).toThrow(); // não sobrou processo
  });

  it('cancelamento do servidor mata o processo e propaga como "cancelado"', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await expect(exec('hang')(job(), () => undefined, ac.signal, ctx().context)).rejects.toThrow(/cancelado/i);
    await new Promise((r) => setTimeout(r, 400));
    expect(() => process.kill(readDump().pid, 0)).toThrow();
  });

  it('sem contexto do Runner, recusa executar', async () => {
    await expect(exec('ok')(job(), () => undefined, new AbortController().signal)).rejects.toThrow(/contexto/i);
  });

  it('falha sem mudanças limpa o worktree', async () => {
    await exec('error_result')(job(), () => undefined, new AbortController().signal, ctx().context).catch(() => undefined);
    const wt = join(data, 'worktrees');
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
  });
});
