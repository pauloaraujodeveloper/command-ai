import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentExecutor } from '../src/agent/executor.ts';
import { demoModel } from '../src/agent/demo-model.ts';
import type { ExecutorContext, JobPayload, RunnerClient } from '../src/runner.ts';

const git = promisify(execFile);
let repo: string;
let data: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ca-ae-repo-'));
  data = await mkdtemp(join(tmpdir(), 'ca-ae-data-'));
  await git('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'original\n', 'utf8');
  await git('git', ['add', '-A'], { cwd: repo });
  await git('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

const job = (over: Partial<JobPayload> = {}): JobPayload => ({ taskId: 'task-1', executionId: 'exec-1', workspacePath: repo, prompt: 'Documente o projeto', model: 'demo', attempt: 1, ...over });

function ctx(approval: { status: string; reason?: string } = { status: 'approved' }) {
  const client = {
    usage: vi.fn(async () => ({ applied: true, cancel: false })),
    requestApproval: vi.fn(async () => ({ approvalId: 'ap1' })),
    approvalStatus: vi.fn(async () => approval),
  } as unknown as RunnerClient;
  return { client, context: { client } as ExecutorContext };
}

const limits = { maxTurns: 20, maxTotalTokens: 1_000_000, timeoutMs: 60_000, maxTokensPerTurn: 4096, maxToolOutputBytes: 1_000_000, approvalPollMs: 5, approvalTimeoutMs: 1000 };

describe('agentExecutor (modelo de demonstração, sem chave)', () => {
  it('trabalha num worktree isolado e entrega um patch; a pasta da pessoa não muda', async () => {
    const ex = agentExecutor({ createModel: () => demoModel(), dataDir: data, limits });
    const { client, context } = ctx();
    const lines: string[] = [];
    const r = await ex(job(), (l) => lines.push(l), new AbortController().signal, context);

    // pasta do usuário intacta
    expect(await readdir(repo)).not.toContain('AGENTE-RELATORIO.md');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('original\n');
    const status = (await git('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim();
    expect(status).toBe('');

    // patch com o relatório criado, sem o rascunho apagado
    expect(r.output).toContain('AGENTE-RELATORIO.md');
    expect(r.output).toMatch(/1 arquivo/);
    expect(r.output).not.toContain('RASCUNHO.tmp');
    const patches = await readdir(join(data, 'patches'));
    expect(patches).toHaveLength(1);
    expect(await readFile(join(data, 'patches', patches[0]!), 'utf8')).toContain('AGENTE-RELATORIO.md');

    // apagar o rascunho passou por aprovação humana
    expect(client.requestApproval).toHaveBeenCalledOnce();
    expect(client.requestApproval).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'delete_file', attempt: 1 }));
    expect(lines.some((l) => /aprova/i.test(l))).toBe(true);
  });

  it('uso é relatado por turno; o relatório final só carrega o que não foi relatado (nada, aqui)', async () => {
    const ex = agentExecutor({ createModel: () => demoModel(), dataDir: data, limits });
    const { client, context } = ctx();
    const r = await ex(job(), () => undefined, new AbortController().signal, context);
    expect((client.usage as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('aprovação negada: o rascunho continua no patch', async () => {
    const ex = agentExecutor({ createModel: () => demoModel(), dataDir: data, limits });
    const { context } = ctx({ status: 'rejected', reason: 'mantenha' });
    const r = await ex(job(), () => undefined, new AbortController().signal, context);
    expect(r.output).toMatch(/2 arquivos/);
    expect(r.output).toContain('RASCUNHO.tmp');
  });

  it('sem contexto do Runner (sem cliente), recusa executar: nunca roda sem aprovação possível', async () => {
    const ex = agentExecutor({ createModel: () => demoModel(), dataDir: data, limits });
    await expect(ex(job(), () => undefined, new AbortController().signal)).rejects.toThrow(/contexto/i);
  });

  it('pasta sem Git: somente leitura (nada é escrito) e o relatório diz isso', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'ca-ae-plain-'));
    try {
      await writeFile(join(plain, 'x.txt'), 'x', 'utf8');
      const ex = agentExecutor({ createModel: () => demoModel(), dataDir: data, limits });
      const { context } = ctx();
      const r = await ex(job({ workspacePath: plain }), () => undefined, new AbortController().signal, context);
      expect(await readdir(plain)).toEqual(['x.txt']);
      expect(r.output).toMatch(/somente leitura/i);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('cancelamento propaga como erro "cancelado" e limpa o worktree sem mudanças', async () => {
    const ac = new AbortController();
    const slow = { model: 'x', turn: (req: { signal: AbortSignal }) => new Promise<never>((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted')))) };
    const ex = agentExecutor({ createModel: () => slow as never, dataDir: data, limits });
    const { context } = ctx();
    setTimeout(() => ac.abort(), 100);
    await expect(ex(job(), () => undefined, ac.signal, context)).rejects.toThrow(/cancelado/i);
    expect(await readdir(join(data, 'worktrees'))).toEqual([]);
  });
});
