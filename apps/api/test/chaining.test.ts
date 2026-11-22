import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyJob } from '@command-ai/shared/signing';
import { buildApp } from '../src/app.ts';

const KEY = 'chaining-test-signing-key-long-123456';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 };
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

let app: FastifyInstance;
beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, orchestrator: { backoffBaseMs: 0, leaseMs: 90_000 } }));
});
afterEach(async () => {
  await app.close();
});

async function scenario(tasks: Array<{ id: string; title: string; dependsOn: string[] }>) {
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email: 'a@example.com', password: 'senha-muito-forte-1' } });
  const h = { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
  const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'P', workspacePath: '/work/repo' } })).json();
  const created = (await app.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id } })).json();
  const r = await app.inject({
    method: 'PATCH',
    url: `/api/v1/executions/${created.execution.id}/plan`,
    headers: h,
    payload: { tasks: tasks.map((t) => ({ ...t, agentId: agent.id, risk: 'low' })) },
  });
  expect(r.statusCode).toBe(200);
  await app.inject({ method: 'POST', url: `/api/v1/executions/${created.execution.id}/start`, headers: h });
  const rr = (await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name: 'r1' } })).json();
  return { h, execId: created.execution.id as string, runner: { authorization: `Bearer ${rr.token}`, 'content-type': 'application/json' } };
}

const claim = async (runner: Record<string, string>) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner });
  return res.statusCode === 200 ? res.json().job : null;
};
const complete = (runner: Record<string, string>, taskId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/runner/tasks/${encodeURIComponent(taskId)}/complete`, headers: runner, payload: { usage: USAGE, attempt: 1, ...payload } });

describe('encadeamento de tarefas', () => {
  it('a primeira tarefa não tem upstream; a dependente recebe resultado e commit da anterior', async () => {
    const { runner } = await scenario([
      { id: 'a', title: 'Analisar', dependsOn: [] },
      { id: 'b', title: 'Implementar', dependsOn: ['a'] },
    ]);
    const first = await claim(runner);
    expect(first.payload.upstream).toEqual([]);
    expect(await claim(runner)).toBeNull(); // b ainda espera a

    const done = await complete(runner, first.payload.taskId, { output: 'Achei 3 problemas', workspaceCommit: SHA1 });
    expect(done.json().applied).toBe(true);

    const second = await claim(runner);
    expect(verifyJob(second, KEY)).toBe(true); // o upstream está coberto pela assinatura
    expect(second.payload.upstream).toEqual([{ taskId: 'a', title: 'Analisar', output: 'Achei 3 problemas', commit: SHA1 }]);
  });

  it('resultado muito longo é cortado no upstream', async () => {
    const { runner } = await scenario([
      { id: 'a', title: 'A', dependsOn: [] },
      { id: 'b', title: 'B', dependsOn: ['a'] },
    ]);
    const first = await claim(runner);
    await complete(runner, first.payload.taskId, { output: 'x'.repeat(50_000) });
    const second = await claim(runner);
    expect(second.payload.upstream[0].output.length).toBeLessThanOrEqual(8_100);
    expect(second.payload.upstream[0].output).toContain('cortado');
    expect(second.payload.upstream[0].commit).toBeUndefined();
  });

  it('só as dependências diretas entram; tarefa independente não recebe nada', async () => {
    const { runner } = await scenario([
      { id: 'a', title: 'A', dependsOn: [] },
      { id: 'c', title: 'C independente', dependsOn: [] },
      { id: 'b', title: 'B', dependsOn: ['a'] },
    ]);
    const jobs = [await claim(runner), await claim(runner)];
    const byTitle = Object.fromEntries(jobs.map((j) => [j.payload.prompt.split('\n')[0], j]));
    await complete(runner, byTitle['A'].payload.taskId, { output: 'saida A', workspaceCommit: SHA1 });
    await complete(runner, byTitle['C independente'].payload.taskId, { output: 'saida C', workspaceCommit: SHA2 });
    const b = await claim(runner);
    expect(b.payload.upstream.map((u: { taskId: string }) => u.taskId)).toEqual(['a']);
  });

  it('com duas dependências, o upstream traz as duas, na ordem do plano', async () => {
    const { runner } = await scenario([
      { id: 'a', title: 'A', dependsOn: [] },
      { id: 'c', title: 'C', dependsOn: [] },
      { id: 'd', title: 'D junta', dependsOn: ['a', 'c'] },
    ]);
    const j1 = await claim(runner);
    const j2 = await claim(runner);
    for (const j of [j1, j2]) await complete(runner, j.payload.taskId, { output: `saida ${j.payload.taskId.split(':')[1]}`, workspaceCommit: j.payload.taskId.endsWith(':a') ? SHA1 : SHA2 });
    const d = await claim(runner);
    expect(d.payload.upstream).toEqual([
      { taskId: 'a', title: 'A', output: 'saida a', commit: SHA1 },
      { taskId: 'c', title: 'C', output: 'saida c', commit: SHA2 },
    ]);
  });

  it('commit mal formado é recusado (nada de caminho, opção ou referência vinda do Runner)', async () => {
    const { runner } = await scenario([{ id: 'a', title: 'A', dependsOn: [] }]);
    const job = await claim(runner);
    for (const bad of ['--upload-pack=x', 'HEAD', '../../etc', 'a'.repeat(39), 'g'.repeat(40)]) {
      const res = await complete(runner, job.payload.taskId, { output: 'x', workspaceCommit: bad });
      expect(res.statusCode, bad).toBe(400);
    }
  });
});
