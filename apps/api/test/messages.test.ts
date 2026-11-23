import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyJob } from '@command-ai/shared/signing';
import { buildApp } from '../src/app.ts';

const KEY = 'messages-test-signing-key-long-12345678';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 };

let app: FastifyInstance;
beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, orchestrator: { backoffBaseMs: 0, leaseMs: 90_000 } }));
});
afterEach(async () => {
  await app.close();
});

type PlanTask = { id: string; title: string; dependsOn: string[] };
const SEQ: PlanTask[] = [{ id: 'a', title: 'Analisar', dependsOn: [] }, { id: 'b', title: 'Executar', dependsOn: ['a'] }];
const PAR: PlanTask[] = [{ id: 'a', title: 'Frente A', dependsOn: [] }, { id: 'c', title: 'Frente C', dependsOn: [] }];

async function scenario(plan: PlanTask[] = SEQ) {
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
  return { h, execId, runner: await mk('r1'), mk };
}
const claim = async (runner: Record<string, string>) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner });
  return res.statusCode === 200 ? res.json().job : null;
};
const url = (taskId: string, action: string) => `/api/v1/runner/tasks/${encodeURIComponent(taskId)}/${action}`;
const send = (runner: Record<string, string>, taskId: string, to: string, content: string, attempt: number | undefined = 1) =>
  app.inject({ method: 'POST', url: url(taskId, 'messages'), headers: runner, payload: { attempt, to, content } });
const read = (runner: Record<string, string>, taskId: string, attempt: number | undefined = 1) =>
  app.inject({ method: 'POST', url: url(taskId, 'messages/read'), headers: runner, payload: { attempt } });
const complete = (runner: Record<string, string>, taskId: string) =>
  app.inject({ method: 'POST', url: url(taskId, 'complete'), headers: runner, payload: { usage: USAGE, attempt: 1, output: 'fim' } });

describe('mensagens entre tarefas (agentes)', () => {
  it('a mensagem enviada a uma tarefa que ainda não começou chega no trabalho dela, assinada, e não é entregue de novo', async () => {
    const { runner } = await scenario();
    const a = await claim(runner);
    const res = await send(runner, a.payload.taskId, 'b', 'Cuidado: o módulo X está quebrado.');
    expect(res.statusCode).toBe(201);
    await complete(runner, a.payload.taskId);

    const b = await claim(runner);
    expect(verifyJob(b, KEY)).toBe(true); // a caixa de entrada está coberta pela assinatura
    expect(b.payload.inbox).toEqual([expect.objectContaining({ from: 'a', fromTitle: 'Analisar', content: 'Cuidado: o módulo X está quebrado.' })]);
    const again = await read(runner, b.payload.taskId);
    expect(again.json().messages).toEqual([]); // já entregue nesta tentativa
  });

  it('com duas tarefas rodando ao mesmo tempo, a mensagem chega pela leitura e só uma vez', async () => {
    const { runner } = await scenario(PAR);
    const a = await claim(runner);
    const c = await claim(runner);
    expect(a && c).toBeTruthy();
    const [from, to] = a.payload.taskId.endsWith(':a') ? [a, c] : [c, a];
    const toPlan = to.payload.taskId.split(':')[1];
    expect((await read(runner, to.payload.taskId)).json().messages).toEqual([]);
    expect((await send(runner, from.payload.taskId, toPlan, 'Estou mexendo em src/x.ts; evite esse arquivo.')).statusCode).toBe(201);
    const got = (await read(runner, to.payload.taskId)).json().messages;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ from: from.payload.taskId.split(':')[1], content: 'Estou mexendo em src/x.ts; evite esse arquivo.' });
    expect((await read(runner, to.payload.taskId)).json().messages).toEqual([]);
    // a resposta
    const fromPlan = from.payload.taskId.split(':')[1];
    expect((await send(runner, to.payload.taskId, fromPlan, 'Entendido.')).statusCode).toBe(201);
    expect((await read(runner, from.payload.taskId)).json().messages.map((m: { content: string }) => m.content)).toEqual(['Entendido.']);
  });

  it('o trabalho traz o plano da execução (os outros nomes e situações) para o agente saber a quem escrever', async () => {
    const { runner, execId } = await scenario();
    const a = await claim(runner);
    expect(a.payload.peers).toEqual([{ taskId: 'b', title: 'Executar', status: 'pending' }]);
    expect(a.payload.taskId).toBe(`${execId}:a`);
  });

  it('em nova tentativa a tarefa recebe de novo as mensagens (o contexto da anterior se perdeu)', async () => {
    const { runner } = await scenario();
    const a = await claim(runner);
    await send(runner, a.payload.taskId, 'b', 'Lembre do X.');
    await complete(runner, a.payload.taskId);
    const b1 = await claim(runner);
    expect(b1.payload.inbox).toHaveLength(1);
    await app.inject({ method: 'POST', url: url(b1.payload.taskId, 'fail'), headers: runner, payload: { attempt: 1, reason: 'falha de teste' } });
    const b2 = await claim(runner);
    expect(b2.payload.attempt).toBe(2);
    expect(b2.payload.inbox.map((m: { content: string }) => m.content)).toEqual(['Lembre do X.']);
    expect((await read(runner, b2.payload.taskId, 2)).json().messages).toEqual([]);
  });

  it('recusas: para si mesma, destinatário inexistente, tarefa já encerrada, tarefa que não está em execução', async () => {
    const { runner } = await scenario(PAR);
    const a = await claim(runner);
    const c = await claim(runner);
    const aPlan = a.payload.taskId.split(':')[1];
    const cPlan = c.payload.taskId.split(':')[1];
    expect((await send(runner, a.payload.taskId, aPlan, 'oi')).statusCode).toBe(422);
    expect((await send(runner, a.payload.taskId, 'nao-existe', 'oi')).statusCode).toBe(404);
    await complete(runner, c.payload.taskId);
    const closed = await send(runner, a.payload.taskId, cPlan, 'tarde demais');
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe('recipient_closed');
    await complete(runner, a.payload.taskId);
    expect((await send(runner, a.payload.taskId, cPlan, 'já terminei')).statusCode).toBe(409); // remetente já não está rodando
    expect((await read(runner, a.payload.taskId)).statusCode).toBe(409);
  });

  it('só o Runner dono, na tentativa atual; conteúdo e id validados', async () => {
    const { runner, mk } = await scenario();
    const a = await claim(runner);
    const intruder = await mk('intruso');
    expect((await send(intruder, a.payload.taskId, 'b', 'oi')).statusCode).toBe(404);
    expect((await read(intruder, a.payload.taskId)).statusCode).toBe(404);
    expect((await send(runner, a.payload.taskId, 'b', 'oi', 9)).statusCode).toBe(409);
    expect((await send(runner, a.payload.taskId, 'b', '')).statusCode).toBe(400);
    expect((await send(runner, a.payload.taskId, 'b', 'x'.repeat(2001))).statusCode).toBe(400);
    expect((await send(runner, a.payload.taskId, 'id inválido!', 'oi')).statusCode).toBe(400);
  });

  it('cada tarefa envia no máximo 20 mensagens', async () => {
    const { runner } = await scenario();
    const a = await claim(runner);
    for (let i = 0; i < 20; i++) expect((await send(runner, a.payload.taskId, 'b', `m${i}`)).statusCode).toBe(201);
    const over = await send(runner, a.payload.taskId, 'b', 'a 21ª');
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('message_limit');
  });

  it('cada mensagem vira um evento no histórico (monitoramento), com prévia curta', async () => {
    const { runner, h, execId } = await scenario();
    const a = await claim(runner);
    await send(runner, a.payload.taskId, 'b', 'y'.repeat(900));
    const ev = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json`, headers: h })).json();
    const items = (ev.items ?? ev.events ?? ev) as Array<{ type: string; payload: { from?: string; to?: string; preview?: string } }>;
    const m = items.find((e) => e.type === 'message.sent');
    expect(m?.payload).toMatchObject({ from: 'a', to: 'b' });
    expect(m!.payload.preview!.length).toBeLessThanOrEqual(220);
  });

  it('o histórico completo de mensagens da execução é visível para a pessoa', async () => {
    const { runner, h, execId } = await scenario();
    const a = await claim(runner);
    await send(runner, a.payload.taskId, 'b', 'Conteúdo completo da mensagem');
    const res = await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/messages`, headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([expect.objectContaining({ from: 'a', to: 'b', content: 'Conteúdo completo da mensagem' })]);
    // outra organização não vê
    const reg2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'B', orgName: 'O2', email: 'b@example.com', password: 'senha-muito-forte-1' } });
    const h2 = { ...H, cookie: `ca_session=${reg2.cookies.find((c) => c.name === 'ca_session')!.value}` };
    expect((await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/messages`, headers: h2 })).statusCode).toBe(404);
  });
});
