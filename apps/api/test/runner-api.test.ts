import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyJob } from '@command-ai/shared/signing';
import { buildApp } from '../src/app.ts';

const KEY = 'runner-api-test-signing-key-long-1234';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50 };

let app: FastifyInstance;
beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, orchestrator: { backoffBaseMs: 0, leaseMs: 90_000 } }));
});
afterEach(async () => {
  await app.close();
});

async function scenario() {
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email: 'a@example.com', password: 'senha-muito-forte-1' } });
  const h = { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
  const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'P', workspacePath: '/work/repo' } })).json();
  const created = (await app.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id } })).json();
  await app.inject({
    method: 'PATCH',
    url: `/api/v1/executions/${created.execution.id}/plan`,
    headers: h,
    payload: { tasks: [{ id: 'a', title: 'Única', agentId: agent.id, dependsOn: [], risk: 'low' }] },
  });
  await app.inject({ method: 'POST', url: `/api/v1/executions/${created.execution.id}/start`, headers: h });
  const mkRunner = async (name: string) => {
    const r = (await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name } })).json();
    return { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' };
  };
  return { h, execId: created.execution.id as string, runner: await mkRunner('r1'), mkRunner };
}

const claim = async (runner: Record<string, string>) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner });
  return res.statusCode === 200 ? res.json().job : null;
};
const url = (taskId: string, action: string) => `/api/v1/runner/tasks/${encodeURIComponent(taskId)}/${action}`;

describe('API do Runner: uso por turno e aprovação de ferramentas', () => {
  it('registra o uso de cada interação com o modelo e ignora o envio repetido', async () => {
    const { runner, h, execId } = await scenario();
    const job = await claim(runner);
    const body = { turn: 1, attempt: job.payload.attempt, usage: { model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } };
    const first = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'usage'), headers: runner, payload: body });
    expect(first.json()).toEqual({ ok: true, applied: true, cancel: false });
    const again = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'usage'), headers: runner, payload: body });
    expect(again.json()).toEqual({ ok: true, applied: false, cancel: false });
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: h })).json();
    expect(detail.execution.inputTokens).toBe(1000);
    expect(detail.execution.cacheReadTokens).toBe(200);
  });

  it('rejeita uso mal formado e uso de um Runner que não é o dono', async () => {
    const { runner, mkRunner } = await scenario();
    const job = await claim(runner);
    const bad = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'usage'), headers: runner, payload: { turn: 0, usage: { model: 'm', inputTokens: -1, outputTokens: 0 } } });
    expect(bad.statusCode).toBe(400);
    const intruder = await mkRunner('intruso');
    const res = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'usage'), headers: intruder, payload: { turn: 1, usage: { model: 'm', inputTokens: 1, outputTokens: 1 } } });
    expect(res.statusCode).toBe(404);
  });

  it('o orçamento estourado no meio da tarefa devolve cancel=true ao Runner', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email: 'b@example.com', password: 'senha-muito-forte-1' } });
    const h = { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
    const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'anthropic', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'P', workspacePath: '/w' } })).json();
    const created = (await app.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id, budgetUsd: 0.001 } })).json();
    await app.inject({ method: 'PATCH', url: `/api/v1/executions/${created.execution.id}/plan`, headers: h, payload: { tasks: [{ id: 'a', title: 'A', agentId: agent.id, dependsOn: [], risk: 'low' }] } });
    await app.inject({ method: 'POST', url: `/api/v1/executions/${created.execution.id}/start`, headers: h });
    const runner = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name: 'r' } })).json().token}`, 'content-type': 'application/json' };
    const job = await claim(runner);
    const out = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'usage'), headers: runner, payload: { turn: 1, attempt: 1, usage: { model: 'claude-sonnet-5-5', inputTokens: 5_000_000, outputTokens: 0 } } });
    expect(out.json()).toEqual({ ok: true, applied: true, cancel: true });
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${created.execution.id}`, headers: h })).json();
    expect(detail.execution.failureReason).toBe('budget_exceeded');
  });

  it('o agente pede aprovação, a pessoa vê os detalhes da ferramenta e decide, e o Runner consulta o resultado', async () => {
    const { runner, h } = await scenario();
    const job = await claim(runner);
    const ask = await app.inject({
      method: 'POST',
      url: url(job.payload.taskId, 'approvals'),
      headers: runner,
      payload: { attempt: 1, tool: 'run_command', summary: 'npm install (com rede)', risk: 'high', argsPreview: '{"command":"npm install","network":true}' },
    });
    expect(ask.statusCode).toBe(201);
    const approvalId = ask.json().approvalId as string;

    const waiting = (await app.inject({ method: 'GET', url: url(job.payload.taskId, `approvals/${approvalId}`), headers: runner })).json();
    expect(waiting).toEqual({ status: 'pending', reason: null });

    const pending = (await app.inject({ method: 'GET', url: '/api/v1/approvals?status=pending', headers: h })).json().items;
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('tool');
    expect(pending[0].tool).toMatchObject({ name: 'run_command', risk: 'high', summary: 'npm install (com rede)' });
    expect(pending[0].tool.argsPreview).toContain('network');

    const dash = (await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: h })).json();
    expect(dash.attention.some((a: { title: string }) => /run_command/.test(a.title))).toBe(true);

    await app.inject({ method: 'POST', url: `/api/v1/approvals/${approvalId}/decide`, headers: h, payload: { decision: 'rejected', reason: 'Sem rede' } });
    const decided = (await app.inject({ method: 'GET', url: url(job.payload.taskId, `approvals/${approvalId}`), headers: runner })).json();
    expect(decided).toEqual({ status: 'rejected', reason: 'Sem rede' });
    // Rejeitar a ferramenta não falha a execução: a tarefa continua rodando.
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${job.payload.executionId}`, headers: h })).json();
    expect(detail.tasks[0].status).toBe('running');
  });

  it('valida o pedido de aprovação e protege contra outro Runner e tarefa que não roda', async () => {
    const { runner, mkRunner } = await scenario();
    const job = await claim(runner);
    const low = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'approvals'), headers: runner, payload: { tool: 'read_file', summary: 'x', risk: 'low' } });
    expect(low.statusCode).toBe(400); // risco baixo nunca pede aprovação
    const intruder = await mkRunner('intruso');
    const other = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'approvals'), headers: intruder, payload: { tool: 'run_command', summary: 'x', risk: 'high' } });
    expect(other.statusCode).toBe(404);
    const stale = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'approvals'), headers: runner, payload: { attempt: 9, tool: 'run_command', summary: 'x', risk: 'high' } });
    expect(stale.statusCode).toBe(409);
    const ask = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'approvals'), headers: runner, payload: { tool: 'run_command', summary: 'x', risk: 'high' } });
    const missing = await app.inject({ method: 'GET', url: url(job.payload.taskId, 'approvals/nao-existe'), headers: runner });
    expect(missing.statusCode).toBe(404);
    const foreign = await app.inject({ method: 'GET', url: url('outra:tarefa', `approvals/${ask.json().approvalId}`), headers: runner });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('API do Runner: lease, tentativa e cancelamento', () => {
  it('o trabalho assinado leva o número da tentativa e o intervalo de heartbeat', async () => {
    const { runner } = await scenario();
    const job = await claim(runner);
    expect(verifyJob(job, KEY)).toBe(true);
    expect(job.payload.attempt).toBe(1);
    expect(job.payload.heartbeatMs).toBe(30_000); // um terço do lease de 90 s
  });

  it('heartbeat renova o lease e avisa o cancelamento da execução', async () => {
    const { runner, h, execId } = await scenario();
    const job = await claim(runner);
    const beat = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'heartbeat'), headers: runner });
    expect(beat.statusCode).toBe(200);
    expect(beat.json()).toEqual({ ok: true, cancel: false });

    await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/cancel`, headers: h });
    const after = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'heartbeat'), headers: runner });
    expect(after.json()).toEqual({ ok: true, cancel: true });
  });

  it('um Runner que não é o dono da tarefa não consegue enviar heartbeat nem relatório', async () => {
    const { runner, mkRunner } = await scenario();
    const job = await claim(runner);
    const other = await mkRunner('intruso');
    expect((await app.inject({ method: 'POST', url: url(job.payload.taskId, 'heartbeat'), headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url(job.payload.taskId, 'complete'), headers: other, payload: { output: 'x', usage: USAGE } })).statusCode).toBe(404);
  });

  it('concluir duas vezes aplica uma só e informa que a segunda foi ignorada', async () => {
    const { runner, h, execId } = await scenario();
    const job = await claim(runner);
    const body = { output: 'ok', usage: USAGE, attempt: job.payload.attempt };
    const first = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'complete'), headers: runner, payload: body });
    const second = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'complete'), headers: runner, payload: body });
    expect(first.json()).toEqual({ ok: true, applied: true });
    expect(second.json()).toEqual({ ok: true, applied: false });
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: h })).json();
    expect(detail.execution.inputTokens).toBe(100);
    expect(detail.execution.status).toBe('succeeded');
  });

  it('relatório com tentativa antiga é ignorado e a tarefa continua rodando', async () => {
    const { runner, h, execId } = await scenario();
    const job = await claim(runner);
    const stale = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'complete'), headers: runner, payload: { output: 'velho', usage: USAGE, attempt: job.payload.attempt + 1 } });
    expect(stale.json()).toEqual({ ok: true, applied: false });
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: h })).json();
    expect(detail.tasks[0].status).toBe('running');
    expect(detail.execution.inputTokens).toBe(0);
  });

  it('falha reporta a tentativa e volta para a fila; a tentativa seguinte recebe o número 2', async () => {
    const { runner } = await scenario();
    const job = await claim(runner);
    const fail = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'fail'), headers: runner, payload: { reason: 'timeout', attempt: 1 } });
    expect(fail.json()).toEqual({ ok: true, applied: true });
    const again = await claim(runner);
    expect(again.payload.attempt).toBe(2);
  });

  it('relatório depois do cancelamento é aceito sem erro e sem efeito', async () => {
    const { runner, h, execId } = await scenario();
    const job = await claim(runner);
    await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/cancel`, headers: h });
    const res = await app.inject({ method: 'POST', url: url(job.payload.taskId, 'complete'), headers: runner, payload: { output: 'tarde', usage: USAGE, attempt: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, applied: false });
    expect((await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: h })).json().execution.status).toBe('cancelled');
  });
});
