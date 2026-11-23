import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyJob } from '@command-ai/shared/signing';
import { buildApp } from '../src/app.ts';

const KEY = 'providers-api-test-signing-key-long-123';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };

let app: FastifyInstance;
beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, orchestrator: { backoffBaseMs: 0 } }));
});
afterEach(async () => app.close());

async function user() {
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email: 'a@example.com', password: 'senha-muito-forte-1' } });
  return { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
}
const agentBody = (providerKind: string, model = 'm') => ({ name: `Ag ${providerKind}`, role: 'r', instructions: 'i', providerKind, model, budgetUsd: 5 });

describe('provedores de modelo', () => {
  it('aceita agentes de todos os provedores e recusa um desconhecido', async () => {
    const h = await user();
    for (const kind of ['anthropic', 'openai', 'deepseek', 'ollama', 'claude_code', 'simulated']) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: agentBody(kind) })).statusCode, kind).toBe(201);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: agentBody('coisa') })).statusCode).toBe(400);
  });

  it('o trabalho assinado leva o provedor do agente (e só o tipo: nenhuma chave, nome de variável ou URL)', async () => {
    const h = await user();
    const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: agentBody('deepseek', 'deepseek-chat') })).json();
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'P', workspacePath: '/w' } })).json();
    // um provedor cadastrado com nome de variável não vaza para o trabalho
    await app.inject({ method: 'POST', url: '/api/v1/providers', headers: h, payload: { kind: 'deepseek', name: 'DS', apiKeyRef: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' } });
    const created = (await app.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/executions/${created.execution.id}/start`, headers: h });
    const runner = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name: 'r' } })).json().token}`, 'content-type': 'application/json' };
    const job = (await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner })).json().job;
    expect(verifyJob(job, KEY)).toBe(true);
    expect(job.payload.provider).toBe('deepseek');
    expect(job.payload.model).toBe('deepseek-chat');
    expect(JSON.stringify(job.payload)).not.toMatch(/DEEPSEEK_API_KEY|apiKeyRef|baseURL/);
  });

  it('as capacidades de cada provedor estão no cadastro, inclusive DeepSeek', async () => {
    const h = await user();
    const res = await app.inject({ method: 'POST', url: '/api/v1/providers', headers: h, payload: { kind: 'deepseek', name: 'DS', apiKeyRef: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().capabilities).toMatchObject({ toolCalling: true, usageMetrics: true });
  });
});
