import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const H = { 'x-command-ai': '1', 'content-type': 'application/json' };

let app: FastifyInstance;
let logs: string[];

beforeEach(async () => {
  logs = [];
  const stream = new Writable({ write: (chunk, _enc, cb) => (logs.push(String(chunk)), cb()) });
  ({ app } = await buildApp({ jobSigningKey: 'x'.repeat(40), production: false, loggerStream: stream }));
});
afterEach(async () => {
  await app.close();
});

/** Rotas que respondem pelo caminho de erro (401/404/403) não podem gerar aviso ou erro no log. */
describe('caminhos de erro respondem uma única vez, sem aviso no log', () => {
  const privateRoutes: Array<[string, string]> = [
    ['GET', '/api/v1/dashboard'],
    ['GET', '/api/v1/approvals?status=pending'],
    ['GET', '/api/v1/executions'],
    ['GET', '/api/v1/agents'],
    ['GET', '/api/v1/projects'],
    ['GET', '/api/v1/providers'],
    ['GET', '/api/v1/runners'],
    ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/agent-templates'],
    ['GET', '/api/v1/executions/x/events?format=json'],
    ['POST', '/api/v1/agents'],
    ['POST', '/api/v1/projects'],
    ['POST', '/api/v1/executions'],
    ['POST', '/api/v1/executions/x/start'],
    ['POST', '/api/v1/executions/x/cancel'],
    ['POST', '/api/v1/approvals/x/decide'],
    ['POST', '/api/v1/runners'],
    ['POST', '/api/v1/auth/mfa/enroll'],
    ['POST', '/api/v1/auth/mfa/activate'],
    ['POST', '/api/v1/runner/claim'],
    ['POST', '/api/v1/runner/tasks/x/heartbeat'],
    ['POST', '/api/v1/runner/tasks/x/complete'],
    ['POST', '/api/v1/runner/tasks/x/fail'],
    ['POST', '/api/v1/runner/tasks/x/log'],
    ['POST', '/api/v1/runner/tasks/x/usage'],
    ['POST', '/api/v1/runner/tasks/x/approvals'],
    ['GET', '/api/v1/runner/tasks/x/approvals/y'],
  ];

  it.each(privateRoutes)('%s %s sem sessão: 401 e nenhum aviso', async (method, url) => {
    const res = await app.inject({ method: method as 'GET', url, headers: H, payload: method === 'POST' ? {} : undefined });
    expect([401, 403]).toContain(res.statusCode);
    await new Promise((r) => setTimeout(r, 20));
    expect(logs.filter((l) => /already sent|ERR_HTTP_HEADERS_SENT|forget to "return reply"/.test(l))).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('com cookie inválido e sob requisições simultâneas: todas 401 e o log fica limpo', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => app.inject({ method: 'GET', url: i % 2 ? '/api/v1/dashboard' : '/api/v1/approvals?status=pending', headers: { cookie: 'ca_session=bogus' } })),
    );
    expect(results.every((r) => r.statusCode === 401)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toEqual([]);
  });
});
