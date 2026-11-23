import { describe, expect, it, vi } from 'vitest';
import { signJob } from '@command-ai/shared/signing';
import { processNextJob, type RunnerClient, type Executor } from '../src/runner.ts';

const KEY = 'runner-test-signing-key-long-enough';
const ALLOWED = ['/work/repo'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobFor(workspacePath: string, extra: Record<string, unknown> = {}) {
  return signJob(
    { taskId: 'task-1', executionId: 'exec-1', workspacePath, prompt: 'Auditar', model: 'claude-sonnet-5-5', ...extra },
    KEY,
  );
}

function fakeClient(job: ReturnType<typeof jobFor> | null, heartbeat: RunnerClient['heartbeat'] = async () => ({ ok: true, cancel: false })) {
  const reports: Array<{ kind: string; body: unknown }> = [];
  const client: RunnerClient = {
    claim: vi.fn(async () => job),
    log: vi.fn(async (_taskId: string, line: string) => {
      reports.push({ kind: 'log', body: line });
    }),
    heartbeat: vi.fn(heartbeat),
    usage: vi.fn(async () => ({ applied: true, cancel: false })),
    addSubtasks: vi.fn(async () => ({ added: [] })),
    requestApproval: vi.fn(async () => ({ approvalId: 'ap-1' })),
    approvalStatus: vi.fn(async () => ({ status: 'pending' })),
    complete: vi.fn(async (_taskId: string, body: unknown) => {
      reports.push({ kind: 'complete', body });
    }),
    fail: vi.fn(async (_taskId: string, reason: string) => {
      reports.push({ kind: 'fail', body: reason });
    }),
  };
  return { client, reports };
}

const okExecutor: Executor = async (_job, emit) => {
  emit('linha 1');
  return { output: 'pronto', usage: { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 } };
};

describe('processNextJob', () => {
  it('returns idle when there is no job', async () => {
    const { client } = fakeClient(null);
    const result = await processNextJob({ client, executor: okExecutor, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(result).toBe('idle');
  });

  it('runs a correctly signed job inside an allowed workspace and reports completion', async () => {
    const { client, reports } = fakeClient(jobFor('/work/repo'));
    const result = await processNextJob({ client, executor: okExecutor, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(result).toBe('done');
    expect(reports.map((r) => r.kind)).toEqual(['log', 'complete']);
  });

  it('rejects a job with an invalid signature without executing it', async () => {
    const forged = { ...jobFor('/work/repo'), signature: 'forjada' };
    const executor = vi.fn(okExecutor);
    const { client } = fakeClient(forged);
    const result = await processNextJob({ client, executor, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(result).toBe('rejected');
    expect(executor).not.toHaveBeenCalled();
    expect(client.fail).toHaveBeenCalledWith('task-1', 'assinatura_invalida');
  });

  it('refuses a workspace outside the allowlist, including path traversal', async () => {
    const executor = vi.fn(okExecutor);
    const { client } = fakeClient(jobFor('/work/repo/../../etc'));
    const result = await processNextJob({ client, executor, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(result).toBe('rejected');
    expect(executor).not.toHaveBeenCalled();
    expect(client.fail).toHaveBeenCalledWith('task-1', 'workspace_nao_autorizado');
  });

  it('reports a failure when the executor throws', async () => {
    const { client } = fakeClient(jobFor('/work/repo'));
    const boom: Executor = async () => {
      throw new Error('provedor indisponível');
    };
    const result = await processNextJob({ client, executor: boom, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(result).toBe('failed');
    expect(client.fail).toHaveBeenCalledWith('task-1', 'provedor indisponível');
  });
});

describe('número da tentativa nos relatórios', () => {
  it('conclusão e falha levam o número da tentativa do trabalho assinado', async () => {
    const ok = fakeClient(jobFor('/work/repo', { attempt: 2 }));
    await processNextJob({ client: ok.client, executor: okExecutor, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(ok.client.complete).toHaveBeenCalledWith('task-1', expect.objectContaining({ output: 'pronto' }), 2);

    const bad = fakeClient(jobFor('/work/repo', { attempt: 3 }));
    const boom: Executor = async () => {
      throw new Error('x');
    };
    await processNextJob({ client: bad.client, executor: boom, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(bad.client.fail).toHaveBeenCalledWith('task-1', 'x', 3);
  });
});

describe('heartbeat e cancelamento', () => {
  it('envia heartbeat enquanto o executor trabalha e para quando ele termina', async () => {
    const { client } = fakeClient(jobFor('/work/repo', { heartbeatMs: 20 }));
    // Espera por condição (não por tempo fixo): com a máquina carregada os timers atrasam e o teste ficava instável.
    const slow: Executor = async () => {
      const end = Date.now() + 5_000;
      while (vi.mocked(client.heartbeat).mock.calls.length < 3 && Date.now() < end) await sleep(10);
      return { output: 'ok', usage: { model: 'm', inputTokens: 1, outputTokens: 1 } };
    };
    await processNextJob({ client, executor: slow, allowedWorkspaces: ALLOWED, signingKey: KEY });
    const calls = vi.mocked(client.heartbeat).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    await sleep(80);
    expect(vi.mocked(client.heartbeat).mock.calls.length).toBe(calls); // parou de bater depois do fim
  });

  it('cancelamento vindo do servidor interrompe o executor e não envia relatório', async () => {
    let beats = 0;
    const { client } = fakeClient(jobFor('/work/repo', { heartbeatMs: 20, attempt: 1 }), async () => ({ ok: true, cancel: ++beats >= 2 }));
    let aborted = false;
    const waits: Executor = async (_job, _emit, signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('interrompido'));
        });
        setTimeout(resolve, 2_000);
      });
      return { output: 'nunca', usage: { model: 'm', inputTokens: 0, outputTokens: 0 } };
    };
    const started = Date.now();
    const result = await processNextJob({ client, executor: waits, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(result).toBe('cancelled');
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(client.complete).not.toHaveBeenCalled();
    expect(client.fail).not.toHaveBeenCalled();
  });

  it('erro passageiro de rede no heartbeat não derruba a tarefa', async () => {
    let n = 0;
    const { client } = fakeClient(jobFor('/work/repo', { heartbeatMs: 20 }), async () => {
      if (++n <= 2) throw new Error('rede caiu');
      return { ok: true, cancel: false };
    });
    const slow: Executor = async () => {
      await sleep(120);
      return { output: 'ok', usage: { model: 'm', inputTokens: 1, outputTokens: 1 } };
    };
    expect(await processNextJob({ client, executor: slow, allowedWorkspaces: ALLOWED, signingKey: KEY })).toBe('done');
  });

  it('sem heartbeatMs no trabalho, não bate heartbeat (compatível com trabalhos antigos)', async () => {
    const { client } = fakeClient(jobFor('/work/repo'));
    await processNextJob({ client, executor: okExecutor, allowedWorkspaces: ALLOWED, signingKey: KEY });
    expect(client.heartbeat).not.toHaveBeenCalled();
  });
});
