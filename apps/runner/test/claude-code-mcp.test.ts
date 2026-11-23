import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeExecutor } from '../src/agent/claude-code.ts';
import type { ExecutorContext, JobPayload, RunnerClient } from '../src/runner.ts';

const git = promisify(execFile);
const FAKE = resolve(import.meta.dirname, 'fixtures/fake-claude.cjs');
let repo: string;
let data: string;
let dump: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ca-ccm-repo-'));
  data = mkdtempSync(join(tmpdir(), 'ca-ccm-data-'));
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

const job = (over: Partial<JobPayload> = {}): JobPayload => ({ taskId: 'task-1', executionId: 'exec-1', workspacePath: repo, prompt: 'Faça a tarefa', model: 'haiku', provider: 'claude_code', attempt: 1, ...over });
const readDump = () => JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[]; env: Record<string, string>; stdin: string };
const mcpOut = () => join(data, 'mcp-out.json');
type Out = { url: string; token: string; init: { protocolVersion: string }; list: string[]; calls: Array<{ name: string; result: { isError?: boolean; content?: Array<{ text: string }>; code?: number } }> };
const readOut = () => JSON.parse(readFileSync(mcpOut(), 'utf8')) as Out;

const fakeSandbox = () => {
  const runs: Array<Record<string, unknown>> = [];
  return {
    runs,
    sandbox: {
      async run(opts: Record<string, unknown>) {
        runs.push(opts);
        return { exitCode: 0, stdout: 'oi\n', stderr: '', timedOut: false, aborted: false, truncated: false, durationMs: 5 };
      },
    } as never,
  };
};
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

function run(calls: unknown[], over: Partial<Parameters<typeof claudeCodeExecutor>[0]> & { approval?: { status: string; reason?: string } } = {}) {
  const { approval, ...rest } = over;
  const sb = fakeSandbox();
  const c = richCtx(approval);
  const e = claudeCodeExecutor({
    dataDir: data,
    command: { file: process.execPath, prefixArgs: [FAKE] },
    timeoutMs: 20_000,
    approvalPollMs: 5,
    approvalTimeoutMs: 1_000,
    sandbox: sb.sandbox,
    extraEnv: { FAKE_MODE: 'mcp', FAKE_DUMP: dump, FAKE_MCP_OUT: mcpOut(), FAKE_MCP_CALLS: JSON.stringify(calls) },
    ...rest,
  });
  return { ...sb, ...c, result: e(job(), () => undefined, new AbortController().signal, c.context) };
}

describe('claudeCodeExecutor com ferramentas do Runner por MCP', () => {
  it('oferece comandos, apagar, subtarefas e mensagens por MCP e libera só essas no CLI', async () => {
    await run([]).result;
    const out = readOut();
    expect([...out.list].sort()).toEqual(['delete_file', 'plan_subtasks', 'read_messages', 'run_command', 'send_message']);
    expect(out.init.protocolVersion).toBe('2025-06-18');
    const argv = readDump().argv.join(' ');
    expect(argv).toContain('--mcp-config');
    expect(argv).toContain('--strict-mcp-config');
    for (const t of out.list) expect(argv).toContain(`mcp__command_ai__${t}`);
    expect(argv).toMatch(/--allowedTools Write,Edit,mcp__command_ai__/);
    expect(argv).not.toMatch(/dangerously|bypassPermissions|Bash/);
    expect(readDump().stdin).toBeDefined();
  });

  it('o token do MCP não aparece nos argumentos nem no ambiente do CLI; o arquivo de configuração some e o servidor fecha', async () => {
    await run([]).result;
    const out = readOut();
    const d = readDump();
    expect(d.argv.join(' ')).not.toContain(out.token);
    expect(JSON.stringify(d.env)).not.toContain(out.token);
    expect(d.env.MCP_TOOL_TIMEOUT).toBeDefined();
    expect(readdirSync(join(data, 'mcp'))).toEqual([]);
    await expect(fetch(out.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('run_command roda no sandbox, com o workspace somente leitura e sem rede, e a saída volta ao CLI', async () => {
    const r = run([{ name: 'run_command', args: { command: 'echo oi' } }]);
    await r.result;
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ command: 'echo oi', writable: false, network: false });
    expect(String(r.runs[0]!.root)).toContain('worktrees'); // o worktree, nunca a pasta da pessoa
    expect(r.runs[0]!.root).not.toBe(repo);
    expect(readOut().calls[0]!.result.content![0]!.text).toContain('oi');
    expect(r.client.requestApproval).not.toHaveBeenCalled(); // sem rede e sem escrita não pede aprovação
  });

  it('comando com rede ou com escrita passa pela aprovação humana, e negado não executa', async () => {
    const denied = run([{ name: 'run_command', args: { command: 'curl x', network: true } }], { approval: { status: 'rejected', reason: 'sem rede' } });
    await denied.result;
    expect(denied.client.requestApproval).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'run_command', risk: 'high', attempt: 1 }));
    expect(denied.runs).toHaveLength(0);
    expect(readOut().calls[0]!.result).toMatchObject({ isError: true });
    expect(readOut().calls[0]!.result.content![0]!.text).toContain('sem rede');

    const approved = run([{ name: 'run_command', args: { command: 'npm test', writable: true } }]);
    await approved.result;
    expect(approved.client.requestApproval).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'run_command', risk: 'medium' }));
    expect(approved.runs[0]).toMatchObject({ writable: true, network: false });
  });

  it('apagar arquivo exige aprovação: aprovado apaga no worktree (o patch mostra); negado mantém', async () => {
    const yes = run([{ name: 'delete_file', args: { path: 'a.txt' } }]);
    const r = await yes.result;
    expect(yes.client.requestApproval).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'delete_file' }));
    expect(r.output).toContain('a.txt');
    expect(r.output).toMatch(/-original/);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('original\n'); // a pasta da pessoa continua intacta

    const no = run([{ name: 'delete_file', args: { path: 'a.txt' } }], { approval: { status: 'rejected', reason: 'mantenha' } });
    const r2 = await no.result;
    expect(r2.output).toMatch(/não alterou arquivos/i);
  });

  it('arquivos protegidos e caminhos fora do worktree são recusados também por MCP', async () => {
    const r = run([{ name: 'delete_file', args: { path: '../fora.txt' } }, { name: 'delete_file', args: { path: '.env' } }]);
    await r.result;
    expect(readOut().calls.every((c) => c.result.isError)).toBe(true);
  });

  it('subtarefas e mensagens usam o cliente do Runner com a tentativa certa', async () => {
    const r = run([
      { name: 'plan_subtasks', args: { tasks: [{ id: 's1', title: 'Fazer X' }] } },
      { name: 'send_message', args: { to: 'revisao', content: 'oi' } },
    ]);
    await r.result;
    expect(r.client.addSubtasks).toHaveBeenCalledWith('task-1', { attempt: 1, tasks: [{ id: 's1', title: 'Fazer X', dependsOn: [] }] });
    expect(r.client.sendMessage).toHaveBeenCalledWith('task-1', { attempt: 1, to: 'revisao', content: 'oi' });
    expect(r.client.requestApproval).toHaveBeenCalledOnce(); // só plan_subtasks pediu aprovação; mensagem não
  });

  it('entrada inválida de uma ferramenta volta como erro e nada executa', async () => {
    const r = run([{ name: 'run_command', args: { command: 'x', extra: 1 } }, { name: 'run_command', args: {} }]);
    await r.result;
    expect(r.runs).toHaveLength(0);
    expect(readOut().calls.every((c) => c.result.isError)).toBe(true);
  });

  it('sem sandbox, run_command nem é oferecida (comandos nunca rodam fora do contêiner)', async () => {
    const r = run([{ name: 'run_command', args: { command: 'ls' } }], { sandbox: undefined });
    await r.result;
    expect(readOut().list).not.toContain('run_command');
    expect(readOut().calls[0]!.result.code).toBe(-32602); // o servidor recusa o que não ofereceu
  });

  it('pasta sem Git (somente leitura): sem apagar, e run_command só leitura', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ca-ccm-plain-'));
    try {
      writeFileSync(join(plain, 'x.txt'), 'x');
      const sb = fakeSandbox();
      const c = richCtx();
      const e = claudeCodeExecutor({ dataDir: data, command: { file: process.execPath, prefixArgs: [FAKE] }, sandbox: sb.sandbox, timeoutMs: 20_000, extraEnv: { FAKE_MODE: 'mcp', FAKE_DUMP: dump, FAKE_MCP_OUT: mcpOut(), FAKE_MCP_CALLS: '[]' } });
      await e(job({ workspacePath: plain }), () => undefined, new AbortController().signal, c.context);
      expect(readOut().list).not.toContain('delete_file');
      expect(readOut().list).toContain('run_command');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('cancelamento no meio de uma aprovação: o servidor fecha e o worktree é limpo', async () => {
    const ac = new AbortController();
    const sb = fakeSandbox();
    const c = richCtx({ status: 'pending' });
    const e = claudeCodeExecutor({
      dataDir: data,
      command: { file: process.execPath, prefixArgs: [FAKE] },
      sandbox: sb.sandbox,
      approvalPollMs: 5,
      approvalTimeoutMs: 30_000,
      timeoutMs: 20_000,
      extraEnv: { FAKE_MODE: 'mcp', FAKE_DUMP: dump, FAKE_MCP_OUT: mcpOut(), FAKE_MCP_CALLS: JSON.stringify([{ name: 'delete_file', args: { path: 'a.txt' } }]) },
    });
    const p = e(job(), () => undefined, ac.signal, c.context);
    setTimeout(() => ac.abort(), 600);
    await expect(p).rejects.toThrow(/cancelado/i);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(data, 'worktrees')) ? readdirSync(join(data, 'worktrees')) : []).toEqual([]);
    expect(readdirSync(join(data, 'mcp'))).toEqual([]);
  });
});
