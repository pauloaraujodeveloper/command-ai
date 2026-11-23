import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const KEY = 'subtasks-test-signing-key-long-1234567';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 };
const SHA_A = 'a'.repeat(40);
const SHA_S1 = 'c'.repeat(40);
const SHA_S2 = 'd'.repeat(40);

let app: FastifyInstance;
beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, orchestrator: { backoffBaseMs: 0, leaseMs: 90_000 } }));
});
afterEach(async () => {
  await app.close();
});

type PlanTask = { id: string; title: string; dependsOn: string[]; risk?: string };

async function scenario(plan: PlanTask[] = [{ id: 'a', title: 'Analisar', dependsOn: [] }, { id: 'b', title: 'Executar', dependsOn: ['a'] }]) {
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email: 'a@example.com', password: 'senha-muito-forte-1' } });
  const h = { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
  const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'P', workspacePath: '/w' } })).json();
  const created = (await app.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id } })).json();
  const execId = created.execution.id as string;
  const r = await app.inject({ method: 'PATCH', url: `/api/v1/executions/${execId}/plan`, headers: h, payload: { tasks: plan.map((t) => ({ risk: 'low', ...t, agentId: agent.id })) } });
  expect(r.statusCode).toBe(200);
  await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers: h });
  const mk = async (name: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name } })).json().token}`, 'content-type': 'application/json' });
  return { h, execId, agent, runner: await mk('r1'), mk };
}
const claim = async (runner: Record<string, string>) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner });
  return res.statusCode === 200 ? res.json().job : null;
};
const sub = (runner: Record<string, string>, taskId: string, tasks: unknown[], attempt: number | undefined = 1) =>
  app.inject({ method: 'POST', url: `/api/v1/runner/tasks/${encodeURIComponent(taskId)}/subtasks`, headers: runner, payload: { attempt, tasks } });
const complete = (runner: Record<string, string>, taskId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/runner/tasks/${encodeURIComponent(taskId)}/complete`, headers: runner, payload: { usage: USAGE, attempt: 1, ...payload } });
const detail = async (h: Record<string, string>, execId: string) => (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: h })).json();

describe('subtarefas criadas pelo agente', () => {
  it('cria as subtarefas pendentes, dependendo da tarefa que as criou, e a dependente passa a esperar as folhas', async () => {
    const { runner, h, execId } = await scenario();
    const a = await claim(runner);
    const res = await sub(runner, a.payload.taskId, [
      { id: 's1', title: 'Parte 1', risk: 'low' },
      { id: 's2', title: 'Parte 2', dependsOn: ['s1'], risk: 'low' },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json().added).toEqual(['s1', 's2']);

    const d = await detail(h, execId);
    const by = Object.fromEntries(d.tasks.map((t: { planId: string }) => [t.planId, t]));
    expect(by.s1.dependsOn).toEqual([`${execId}:a`]);
    expect(by.s2.dependsOn).toEqual([`${execId}:s1`]);
    expect(by.s1.status).toBe('pending');
    // "Executar" (b) agora também espera a folha s2 (e continua esperando a)
    expect(by.b.dependsOn.sort()).toEqual([`${execId}:a`, `${execId}:s2`].sort());
  });

  it('fluxo completo: as subtarefas rodam em ordem, herdam o resultado da anterior e a dependente só roda depois', async () => {
    const { runner, h, execId } = await scenario();
    const a = await claim(runner);
    await sub(runner, a.payload.taskId, [
      { id: 's1', title: 'Parte 1' },
      { id: 's2', title: 'Parte 2', dependsOn: ['s1'] },
    ]);
    await complete(runner, a.payload.taskId, { output: 'saida a', workspaceCommit: SHA_A });

    const s1 = await claim(runner);
    expect(s1.payload.taskId).toBe(`${execId}:s1`);
    expect(await claim(runner)).toBeNull(); // s2 e b esperam
    expect(s1.payload.upstream).toEqual([{ taskId: 'a', title: 'Analisar', output: 'saida a', commit: SHA_A }]);
    await complete(runner, s1.payload.taskId, { output: 'saida s1', workspaceCommit: SHA_S1 });

    const s2 = await claim(runner);
    expect(s2.payload.taskId).toBe(`${execId}:s2`);
    expect(s2.payload.upstream.map((u: { taskId: string }) => u.taskId)).toEqual(['s1']);
    expect((await detail(h, execId)).execution.status).toBe('running');
    await complete(runner, s2.payload.taskId, { output: 'saida s2', workspaceCommit: SHA_S2 });

    const b = await claim(runner);
    expect(b.payload.taskId).toBe(`${execId}:b`);
    expect(b.payload.upstream.map((u: { taskId: string; commit: string }) => [u.taskId, u.commit])).toEqual([['a', SHA_A], ['s2', SHA_S2]]);
    await complete(runner, b.payload.taskId, { output: 'saida b' });
    expect((await detail(h, execId)).execution.status).toBe('succeeded');
  });

  it('a execução só termina quando as subtarefas também terminam', async () => {
    const { runner, h, execId } = await scenario([{ id: 'a', title: 'Única', dependsOn: [] }]);
    const a = await claim(runner);
    await sub(runner, a.payload.taskId, [{ id: 's1', title: 'Extra' }]);
    await complete(runner, a.payload.taskId, { output: 'x' });
    expect((await detail(h, execId)).execution.status).toBe('running');
    const s1 = await claim(runner);
    await complete(runner, s1.payload.taskId, { output: 'y' });
    expect((await detail(h, execId)).execution.status).toBe('succeeded');
  });

  it('o risco da subtarefa nunca é menor que o da tarefa que a criou; risco alto pede aprovação humana', async () => {
    const { runner, h, execId } = await scenario([{ id: 'a', title: 'Média', dependsOn: [], risk: 'medium' }]);
    const a = await claim(runner);
    await sub(runner, a.payload.taskId, [
      { id: 's1', title: 'Baixa pedida', risk: 'low' },
      { id: 's2', title: 'Publicar', risk: 'high' },
    ]);
    const d = await detail(h, execId);
    const risk = Object.fromEntries(d.tasks.map((t: { planId: string; risk: string }) => [t.planId, t.risk]));
    expect(risk.s1).toBe('medium');
    expect(risk.s2).toBe('high');
    await complete(runner, a.payload.taskId, { output: 'x' });
    const approvals = (await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: h })).json().items;
    expect(approvals.filter((x: { status: string; task?: { title: string } }) => x.status === 'pending').map((x: { task?: { title: string } }) => x.task?.title)).toEqual(['Publicar']);
  });

  it('o agente da subtarefa é o da tarefa por padrão; agente de outra organização é recusado', async () => {
    const { runner, h, execId, agent } = await scenario();
    const a = await claim(runner);
    const reg2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'B', orgName: 'O2', email: 'b@example.com', password: 'senha-muito-forte-1' } });
    const h2 = { ...H, cookie: `ca_session=${reg2.cookies.find((c) => c.name === 'ca_session')!.value}` };
    const foreign = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h2, payload: { name: 'Outro', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 5 } })).json();
    const bad = await sub(runner, a.payload.taskId, [{ id: 's1', title: 'X', agentId: foreign.id }]);
    expect(bad.statusCode).toBe(404);
    const ok = await sub(runner, a.payload.taskId, [{ id: 's1', title: 'X' }]);
    expect(ok.statusCode).toBe(201);
    expect((await detail(h, execId)).tasks.find((t: { planId: string }) => t.planId === 's1').agentId).toBe(agent.id);
  });

  it('entradas inválidas: id repetido ou já existente, dependência inexistente, ciclo, lote grande demais', async () => {
    const { runner } = await scenario();
    const a = await claim(runner);
    const t = a.payload.taskId;
    expect((await sub(runner, t, [{ id: 'b', title: 'Colide com o plano' }])).statusCode).toBe(409);
    expect((await sub(runner, t, [{ id: 's1', title: 'A' }, { id: 's1', title: 'B' }])).statusCode).toBe(422);
    expect((await sub(runner, t, [{ id: 's1', title: 'A', dependsOn: ['nao-existe'] }])).statusCode).toBe(422);
    expect((await sub(runner, t, [{ id: 's1', title: 'A', dependsOn: ['s2'] }, { id: 's2', title: 'B', dependsOn: ['s1'] }])).statusCode).toBe(422);
    expect((await sub(runner, t, Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, title: `T${i}` })))).statusCode).toBe(400);
    expect((await sub(runner, t, [{ id: 'com espaço', title: 'A' }])).statusCode).toBe(400);
    expect((await sub(runner, t, [])).statusCode).toBe(400);
    // nada foi criado por nenhuma das tentativas
    expect((await sub(runner, t, [{ id: 's1', title: 'Boa' }])).statusCode).toBe(201);
  });

  it('limites: no máximo 25 tarefas na execução e profundidade 2', async () => {
    const { runner } = await scenario([{ id: 'a', title: 'Única', dependsOn: [] }]);
    const a = await claim(runner);
    for (let batch = 0; batch < 4; batch++) {
      const res = await sub(runner, a.payload.taskId, Array.from({ length: 5 }, (_, i) => ({ id: `b${batch}x${i}`, title: `T${batch}${i}` })));
      expect(res.statusCode).toBe(201);
    }
    // 1 + 20 = 21; mais 5 daria 26
    const over = await sub(runner, a.payload.taskId, Array.from({ length: 5 }, (_, i) => ({ id: `z${i}`, title: `Z${i}` })));
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('plan_limit');
    expect((await sub(runner, a.payload.taskId, [{ id: 'z0', title: 'Cabe' }, { id: 'z1', title: 'Cabe 2' }, { id: 'z2', title: 'Cabe 3' }, { id: 'z3', title: 'Cabe 4' }])).statusCode).toBe(201);
  });

  it('subtarefa de subtarefa vai até a profundidade 2; a terceira geração é recusada', async () => {
    const { runner } = await scenario([{ id: 'a', title: 'Única', dependsOn: [] }]);
    const a = await claim(runner);
    await sub(runner, a.payload.taskId, [{ id: 'g1', title: 'Geração 1' }]);
    await complete(runner, a.payload.taskId, { output: 'x' });
    const g1 = await claim(runner);
    expect((await sub(runner, g1.payload.taskId, [{ id: 'g2', title: 'Geração 2' }])).statusCode).toBe(201);
    await complete(runner, g1.payload.taskId, { output: 'y' });
    const g2 = await claim(runner);
    const third = await sub(runner, g2.payload.taskId, [{ id: 'g3', title: 'Geração 3' }]);
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe('plan_limit');
  });

  it('só o Runner dono da tarefa em execução, na tentativa atual, pode criar subtarefas', async () => {
    const { runner, mk } = await scenario();
    const a = await claim(runner);
    const intruder = await mk('intruso');
    expect((await sub(intruder, a.payload.taskId, [{ id: 's1', title: 'X' }])).statusCode).toBe(404);
    expect((await sub(runner, a.payload.taskId, [{ id: 's1', title: 'X' }], 7)).statusCode).toBe(409); // tentativa errada
    await complete(runner, a.payload.taskId, { output: 'fim' });
    expect((await sub(runner, a.payload.taskId, [{ id: 's1', title: 'X' }])).statusCode).toBe(409); // já terminou
  });

  it('execução cancelada não aceita subtarefas', async () => {
    const { runner, h, execId } = await scenario();
    const a = await claim(runner);
    await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/cancel`, headers: h });
    expect((await sub(runner, a.payload.taskId, [{ id: 's1', title: 'X' }])).statusCode).toBe(409);
  });

  it('avisa o painel com o evento plan.updated', async () => {
    const { runner, h, execId } = await scenario();
    const a = await claim(runner);
    await sub(runner, a.payload.taskId, [{ id: 's1', title: 'X' }]);
    const ev = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json`, headers: h })).json();
    const items = (ev.items ?? ev.events ?? ev) as Array<{ type: string; payload: { added?: string[] } }>;
    const upd = items.find((e) => e.type === 'plan.updated');
    expect(upd?.payload.added).toEqual(['s1']);
  });
});
