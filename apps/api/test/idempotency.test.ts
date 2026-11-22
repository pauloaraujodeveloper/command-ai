import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const KEY = 'idempotency-test-signing-key-long-1234';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const PASSWORD = 'senha-muito-forte-1';

let app: FastifyInstance;
async function make(extra: { idempotencyTtlMs?: number; idempotencyMaxKeys?: number } = {}) {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, ...extra }));
}
beforeEach(async () => make());
afterEach(async () => app.close());

async function user(email = 'a@example.com') {
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email, password: PASSWORD } });
  const h = { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
  const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'P', workspacePath: '/w' } })).json();
  return { h, agent, project, body: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id } };
}
const post = (h: Record<string, string>, url: string, payload: unknown, key?: string) =>
  app.inject({ method: 'POST', url, headers: key ? { ...h, 'idempotency-key': key } : h, payload: payload as object });
const executions = async (h: Record<string, string>) => (await app.inject({ method: 'GET', url: '/api/v1/executions', headers: h })).json().items as Array<{ id: string }>;

describe('Idempotency-Key', () => {
  it('a mesma chave com o mesmo corpo devolve a mesma resposta e não cria de novo (clique duplo)', async () => {
    const { h, body } = await user();
    const first = await post(h, '/api/v1/executions', body, 'chave-0001-abcd');
    const second = await post(h, '/api/v1/executions', body, 'chave-0001-abcd');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().execution.id).toBe(first.json().execution.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await executions(h)).toHaveLength(1);
  });

  it('sem chave, o comportamento não muda: cada requisição cria', async () => {
    const { h, body } = await user();
    await post(h, '/api/v1/executions', body);
    await post(h, '/api/v1/executions', body);
    expect(await executions(h)).toHaveLength(2);
  });

  it('a mesma chave com outro corpo ou outra rota é recusada (422) e nada é criado', async () => {
    const { h, body } = await user();
    await post(h, '/api/v1/executions', body, 'chave-0002-abcd');
    const other = await post(h, '/api/v1/executions', { ...body, goal: 'Outra meta bem diferente' }, 'chave-0002-abcd');
    expect(other.statusCode).toBe(422);
    expect(other.json().code).toBe('idempotency_key_reuse');
    const route = await post(h, '/api/v1/projects', { name: 'P2', workspacePath: '/x' }, 'chave-0002-abcd');
    expect(route.statusCode).toBe(422);
    expect(await executions(h)).toHaveLength(1);
  });

  it('a ordem dos campos do corpo não muda a identidade da requisição', async () => {
    const { h, body } = await user();
    const first = await post(h, '/api/v1/executions', body, 'chave-0003-abcd');
    const reordered = { agentId: body.agentId, projectId: body.projectId, goal: body.goal };
    const second = await post(h, '/api/v1/executions', reordered, 'chave-0003-abcd');
    expect(second.statusCode).toBe(201);
    expect(second.json().execution.id).toBe(first.json().execution.id);
  });

  it('chave inválida (curta, com caracteres estranhos ou longa) é 400', async () => {
    const { h, body } = await user();
    for (const bad of ['curta', 'tem espaço aqui', 'x'.repeat(129), 'chave/../x1234']) {
      const res = await post(h, '/api/v1/executions', body, bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().code).toBe('invalid_idempotency_key');
    }
    expect(await executions(h)).toHaveLength(0);
  });

  it('requisição que falhou não fica guardada: dá para repetir a chave com o corpo corrigido', async () => {
    const { h, body } = await user();
    const bad = await post(h, '/api/v1/executions', { ...body, goal: 'x' }, 'chave-0004-abcd'); // meta curta demais
    expect(bad.statusCode).toBe(400);
    const ok = await post(h, '/api/v1/executions', body, 'chave-0004-abcd');
    expect(ok.statusCode).toBe(201);
    expect(await executions(h)).toHaveLength(1);
  });

  it('cinco requisições simultâneas com a mesma chave criam exatamente uma execução', async () => {
    const { h, body } = await user();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(h, '/api/v1/executions', body, 'chave-0005-abcd')));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().execution.id)).size).toBe(1);
    expect(await executions(h)).toHaveLength(1);
  });

  it('a chave vale por conta: outra organização usando a mesma chave cria a própria', async () => {
    const a = await user('a@example.com');
    const b = await user('b@example.com');
    const ra = await post(a.h, '/api/v1/executions', a.body, 'chave-0006-abcd');
    const rb = await post(b.h, '/api/v1/executions', b.body, 'chave-0006-abcd');
    expect(rb.statusCode).toBe(201);
    expect(rb.json().execution.id).not.toBe(ra.json().execution.id);
    expect(rb.headers['idempotent-replayed']).toBeUndefined();
  });

  it('criação de Runner ignora a chave: o token (segredo) nunca é guardado para repetir', async () => {
    const { h } = await user();
    const r1 = await post(h, '/api/v1/runners', { name: 'r' }, 'chave-0007-abcd');
    const r2 = await post(h, '/api/v1/runners', { name: 'r' }, 'chave-0007-abcd');
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().token).not.toBe(r2.json().token);
  });

  it('agentes e projetos também são protegidos', async () => {
    const { h } = await user();
    const agent = { name: 'Novo', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 };
    const a1 = await post(h, '/api/v1/agents', agent, 'chave-0008-agente');
    const a2 = await post(h, '/api/v1/agents', agent, 'chave-0008-agente');
    expect(a2.json().id).toBe(a1.json().id);
    const p1 = await post(h, '/api/v1/projects', { name: 'Proj', workspacePath: '/p' }, 'chave-0008-proj1');
    const p2 = await post(h, '/api/v1/projects', { name: 'Proj', workspacePath: '/p' }, 'chave-0008-proj1');
    expect(p2.json().id).toBe(p1.json().id);
    const agents = (await app.inject({ method: 'GET', url: '/api/v1/agents', headers: h })).json().items;
    expect(agents.filter((x: { name: string }) => x.name === 'Novo')).toHaveLength(1);
  });

  it('depois do prazo a chave expira e a mesma requisição cria de novo', async () => {
    await app.close();
    await make({ idempotencyTtlMs: 5 });
    const { h, body } = await user();
    const first = await post(h, '/api/v1/executions', body, 'chave-0009-abcd');
    await new Promise((r) => setTimeout(r, 30));
    const second = await post(h, '/api/v1/executions', body, 'chave-0009-abcd');
    expect(second.json().execution.id).not.toBe(first.json().execution.id);
  });

  it('o registro de chaves tem limite por organização: as mais antigas saem primeiro', async () => {
    await app.close();
    await make({ idempotencyMaxKeys: 3 });
    const { h, body } = await user();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await post(h, '/api/v1/executions', body, `chave-limite-${i}-abc`);
      ids.push(r.json().execution.id);
    }
    const recent = await post(h, '/api/v1/executions', body, 'chave-limite-4-abc'); // ainda guardada
    expect(recent.headers['idempotent-replayed']).toBe('true');
    const oldest = await post(h, '/api/v1/executions', body, 'chave-limite-0-abc'); // já saiu: cria de novo
    expect(oldest.headers['idempotent-replayed']).toBeUndefined();
    expect(oldest.json().execution.id).not.toBe(ids[0]);
  });
});
