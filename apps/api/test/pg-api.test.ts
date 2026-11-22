import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { verifyJob } from '@command-ai/shared/signing';
import { buildApp } from '../src/app.ts';
import { totpCode } from '../src/auth.ts';
import { createPool, DEFAULT_APP_ROLE, grantAppRole, migrate } from '../src/db.ts';
import { loadEnvFiles } from '../src/env.ts';
import { createNeonVerifier } from '../src/neon-auth.ts';
import { PgRepo } from '../src/pg-repo.ts';

loadEnvFiles();

// A API inteira em modo PostgreSQL, com DUAS instâncias (A e B) sobre o mesmo banco e o papel restrito (RLS valendo).
const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_URL_APP;
const schema = `ca_api_${randomBytes(5).toString('hex')}`;
const KEY = 'pg-api-test-signing-key-long-enough-123';
const NEON_BASE = 'https://ep-pgapi.neonauth.example.neon.tech/neondb/auth';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const PASSWORD = 'senha-muito-forte-1';
const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50 };
const uid = () => randomBytes(4).toString('hex');

let owner: pg.Pool;
let A: FastifyInstance;
let B: FastifyInstance;
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

async function instance(): Promise<FastifyInstance> {
  const jwks = createLocalJWKSet({ keys: [publicJwk as never] });
  const repo = new PgRepo({ pool: createPool(appUrl!), schema, orchestrator: { backoffBaseMs: 0, leaseMs: 90_000 } });
  const { app } = await buildApp({
    jobSigningKey: KEY,
    production: false,
    logger: false,
    repo,
    neonAuth: createNeonVerifier({ baseUrl: NEON_BASE, jwksUrl: `${NEON_BASE}/jwks`, getKey: jwks }),
  });
  return app;
}

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => `ca_session=${res.cookies.find((c) => c.name === 'ca_session')!.value}`;

async function register(app: FastifyInstance, email = `u-${uid()}@example.com`) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'Ana', orgName: `Org ${uid()}`, email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return { email, headers: { ...H, cookie: cookieOf(res) } };
}

async function setup(app: FastifyInstance, headers: Record<string, string>, tasks?: object[]) {
  const agent = (await app.inject({ method: 'POST', url: '/api/v1/agents', headers, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'P', workspacePath: '/work/repo' } })).json();
  const created = (await app.inject({ method: 'POST', url: '/api/v1/executions', headers, payload: { goal: 'Meta de teste', projectId: project.id, agentId: agent.id } })).json();
  const execId = created.execution.id as string;
  await app.inject({ method: 'PATCH', url: `/api/v1/executions/${execId}/plan`, headers, payload: { tasks: tasks ?? [{ id: 'a', title: 'Única', agentId: agent.id, dependsOn: [], risk: 'low' }] } });
  return { agent, project, execId };
}

const mkRunner = async (app: FastifyInstance, headers: Record<string, string>) => {
  const r = (await app.inject({ method: 'POST', url: '/api/v1/runners', headers, payload: { name: 'N' } })).json();
  return { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' };
};
const claim = async (app: FastifyInstance, runner: Record<string, string>) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner });
  return res.statusCode === 200 ? res.json().job : null;
};
const taskUrl = (id: string, action: string) => `/api/v1/runner/tasks/${encodeURIComponent(id)}/${action}`;

describe.skipIf(!ownerUrl || !appUrl)('API em modo PostgreSQL com duas instâncias', () => {
  beforeAll(async () => {
    owner = createPool(ownerUrl!);
    await migrate(owner, schema);
    await grantAppRole(owner, schema, DEFAULT_APP_ROLE);
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1' };
    A = await instance();
    B = await instance();
  }, 90_000);

  afterAll(async () => {
    await A?.close();
    await B?.close();
    await owner?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.end();
  }, 90_000);

  it('cadastro numa instância, sessão e leitura na outra; senha errada continua sendo recusada', async () => {
    const { email, headers } = await register(A);
    const me = await B.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
    expect(JSON.stringify(me.json())).not.toMatch(/passwordHash|mfaSecret/);

    const login = await B.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const wrong = await B.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email, password: 'errada-errada-1' } });
    expect(wrong.statusCode).toBe(401);
    const dup = await B.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'X', orgName: 'Y', email, password: PASSWORD } });
    expect(dup.statusCode).toBe(409);
    const noSession = await B.inject({ method: 'GET', url: '/api/v1/executions' });
    expect(noSession.statusCode).toBe(401);
  }, 90_000);

  it('execução criada na A, tarefa reivindicada e concluída pelo Runner na B, resultado visto na A', async () => {
    const { headers } = await register(A);
    const { execId } = await setup(A, headers);
    const runner = await mkRunner(A, headers);
    await A.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers });

    const job = await claim(B, runner); // outra instância
    expect(job).not.toBeNull();
    expect(verifyJob(job, KEY)).toBe(true);
    expect(job.payload.attempt).toBe(1);

    const beat = await A.inject({ method: 'POST', url: taskUrl(job.payload.taskId, 'heartbeat'), headers: runner });
    expect(beat.json()).toEqual({ ok: true, cancel: false });
    await B.inject({ method: 'POST', url: taskUrl(job.payload.taskId, 'log'), headers: runner, payload: { line: 'trabalhando' } });
    const done = await B.inject({ method: 'POST', url: taskUrl(job.payload.taskId, 'complete'), headers: runner, payload: { output: 'ok', usage: USAGE, attempt: 1 } });
    expect(done.json()).toEqual({ ok: true, applied: true });
    const dup = await A.inject({ method: 'POST', url: taskUrl(job.payload.taskId, 'complete'), headers: runner, payload: { output: 'ok', usage: USAGE, attempt: 1 } });
    expect(dup.json()).toEqual({ ok: true, applied: false });

    const detail = (await A.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers })).json();
    expect(detail.execution.status).toBe('succeeded');
    expect(detail.execution.inputTokens).toBe(100); // contado uma vez só

    const events = (await B.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json`, headers })).json().items;
    const seqs = events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(events.some((e: { payload: { line?: string } }) => e.payload.line === 'trabalhando')).toBe(true);
    const replay = (await A.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json&after=${seqs[2]}`, headers })).json().items;
    expect(replay.map((e: { seq: number }) => e.seq)).toEqual(seqs.slice(3));

    const audit = (await A.inject({ method: 'GET', url: '/api/v1/audit', headers })).json().items;
    expect(audit.some((a: { action: string }) => a.action === 'execution.started')).toBe(true);
  }, 120_000);

  it('o cancelamento feito numa instância chega ao Runner pela outra, no heartbeat', async () => {
    const { headers } = await register(A);
    const { execId } = await setup(A, headers);
    const runner = await mkRunner(A, headers);
    await A.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers });
    const job = await claim(A, runner);
    await A.inject({ method: 'POST', url: `/api/v1/executions/${execId}/cancel`, headers });
    const beat = await B.inject({ method: 'POST', url: taskUrl(job.payload.taskId, 'heartbeat'), headers: runner });
    expect(beat.json()).toEqual({ ok: true, cancel: true });
    const late = await B.inject({ method: 'POST', url: taskUrl(job.payload.taskId, 'complete'), headers: runner, payload: { output: 'tarde', usage: USAGE, attempt: 1 } });
    expect(late.json()).toEqual({ ok: true, applied: false });
  }, 120_000);

  it('sem tarefa na fila o Runner recebe 204 sem carregar a organização; com tarefa recebe o trabalho', async () => {
    const { headers } = await register(A);
    const runner = await mkRunner(A, headers);
    const t0 = Date.now();
    const empty = await B.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner });
    expect(empty.statusCode).toBe(204);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const { execId } = await setup(A, headers);
    await A.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers });
    expect(await claim(B, runner)).not.toBeNull();
    const runners = (await A.inject({ method: 'GET', url: '/api/v1/runners', headers })).json().items;
    expect(runners[0].online).toBe(true); // o 204 também atualiza "visto por último"
  }, 120_000);

  it('MFA: ativado numa instância, exigido e sem reuso de código na outra', async () => {
    const { email, headers } = await register(A);
    const secret = (await A.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers })).json().secret as string;
    const activation = totpCode(secret);
    expect((await A.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers, payload: { code: activation } })).statusCode).toBe(200);

    const login = (app: FastifyInstance, totp?: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email, password: PASSWORD, totp } });
    expect((await login(B)).json().code).toBe('mfa_required');
    expect((await login(B, activation)).statusCode).toBe(401); // código da ativação, feita na outra instância
    const fresh = totpCode(secret, Date.now() + 30_000);
    expect((await login(B, fresh)).statusCode).toBe(200);
    expect((await login(A, fresh)).statusCode).toBe(401); // reuso do mesmo código na outra instância
  }, 120_000);

  it('entrada pelo Neon Auth: provisiona na A e reaproveita o mesmo usuário na B', async () => {
    const sub = `sub-${uid()}`;
    const email = `neon-${uid()}@example.com`;
    const jwt = await new SignJWT({ email, name: 'Neon' }).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setSubject(sub).setIssuer(new URL(NEON_BASE).origin).setIssuedAt().setExpirationTime('10m').sign(privateKey);
    const first = await A.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: `Bearer ${jwt}` }, payload: {} });
    const second = await B.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: `Bearer ${jwt}` }, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().user.id).toBe(first.json().user.id);
    expect((await B.inject({ method: 'GET', url: '/api/v1/me', headers: { ...H, cookie: cookieOf(first) } })).json().user.email).toBe(email);
  }, 120_000);

  it('uma organização não enxerga nem altera a outra, mesmo entre instâncias', async () => {
    const a = await register(A);
    const b = await register(B);
    const { execId } = await setup(A, a.headers);
    expect((await B.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: b.headers })).statusCode).toBe(404);
    expect((await B.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json`, headers: b.headers })).statusCode).toBe(404);
    expect((await B.inject({ method: 'POST', url: `/api/v1/executions/${execId}/cancel`, headers: b.headers })).statusCode).toBe(404);
    expect((await B.inject({ method: 'GET', url: '/api/v1/executions', headers: b.headers })).json().items).toEqual([]);
    const dash = (await B.inject({ method: 'GET', url: '/api/v1/dashboard', headers: b.headers })).json();
    expect(dash.recent).toEqual([]);
  }, 120_000);

  it('aprovação decidida numa instância libera a tarefa para o Runner da outra', async () => {
    const { headers } = await register(A);
    const first = await setup(A, headers, undefined);
    void first;
    const high = await setup(A, headers, [{ id: 'deploy', title: 'Publicar', agentId: (await A.inject({ method: 'GET', url: '/api/v1/agents', headers })).json().items[0].id, dependsOn: [], risk: 'high' }]);
    await A.inject({ method: 'POST', url: `/api/v1/executions/${high.execId}/start`, headers });
    const runner = await mkRunner(A, headers);
    const pending = (await B.inject({ method: 'GET', url: '/api/v1/approvals?status=pending', headers })).json().items;
    expect(pending).toHaveLength(1);
    expect(await claim(B, runner)).toBeNull(); // bloqueada até a decisão
    const decided = await A.inject({ method: 'POST', url: `/api/v1/approvals/${pending[0].id}/decide`, headers, payload: { decision: 'approved' } });
    expect(decided.statusCode).toBe(200);
    const job = await claim(B, runner);
    expect(job?.payload.taskId).toBe(`${high.execId}:deploy`);
  }, 120_000);

it('Idempotency-Key vale entre instâncias e sob concorrência: uma única execução no banco', async () => {
    const { headers } = await register(A);
    const agent = (await A.inject({ method: 'POST', url: '/api/v1/agents', headers, payload: { name: 'Ag', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 } })).json();
    const project = (await A.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'P', workspacePath: '/work/repo' } })).json();
    const payload = { goal: 'Meta de teste', projectId: project.id, agentId: agent.id };
    const h = { ...headers, 'idempotency-key': `pg-chave-${uid()}-abcd` };
    // seis requisições ao mesmo tempo, alternando as instâncias
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? A : B).inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload })));
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json().execution.id)).size).toBe(1);
    const list = (await B.inject({ method: 'GET', url: '/api/v1/executions', headers })).json().items;
    expect(list).toHaveLength(1);
    // depois, a repetição na outra instância também devolve o mesmo
    const again = await B.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().execution.id).toBe(list[0].id);
  }, 120_000);
});
