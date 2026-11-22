import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { totpCode } from '../src/auth.ts';
import { createNeonVerifier } from '../src/neon-auth.ts';

const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const PASSWORD = 'senha-muito-forte-1';
const BASE = 'https://ep-mfa.neonauth.example.neon.tech/neondb/auth';
const next = (secret: string, steps = 1) => totpCode(secret, Date.now() + steps * 30_000);

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1' };
});

const neonJwt = (sub: string, email: string) =>
  new SignJWT({ email, name: 'Neon' }).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setSubject(sub).setIssuer(new URL(BASE).origin).setIssuedAt().setExpirationTime('10m').sign(privateKey);

describe('política de MFA obrigatório (requireMfa)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk as never] });
    ({ app } = await buildApp({
      jobSigningKey: 'x'.repeat(40),
      production: false,
      logger: false,
      requireMfa: true,
      neonAuth: createNeonVerifier({ baseUrl: BASE, jwksUrl: `${BASE}/jwks`, getKey: jwks }),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => `ca_session=${res.cookies.find((c) => c.name === 'ca_session')!.value}`;
  const register = async (email = 'ana@example.com') =>
    app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'Ana', orgName: 'Acme', email, password: PASSWORD } });

  it('a sessão recém-criada só alcança /me, a configuração de MFA e o logout', async () => {
    const reg = await register();
    const h = { ...H, cookie: cookieOf(reg) };
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: h });
    expect(me.statusCode).toBe(200);
    expect(me.json().mfaEnrollmentRequired).toBe(true);

    for (const [method, url] of [['GET', '/api/v1/executions'], ['GET', '/api/v1/agents'], ['GET', '/api/v1/approvals'], ['GET', '/api/v1/dashboard'], ['GET', '/api/v1/audit']] as const) {
      const r = await app.inject({ method, url, headers: h });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code).toBe('mfa_enrollment_required');
    }
    const write = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: h, payload: { name: 'A', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'm', budgetUsd: 1 } });
    expect(write.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: h })).statusCode).toBe(200);
  });

  it('a stream de eventos e as rotas de gestão também ficam bloqueadas', async () => {
    const h = { ...H, cookie: cookieOf(await register()) };
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions/x/events?format=json', headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name: 'n' } })).statusCode).toBe(403);
  });

  it('ativar o MFA libera a mesma sessão; código errado não libera', async () => {
    const h = { ...H, cookie: cookieOf(await register()) };
    const secret = (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers: h })).json().secret as string;
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers: h, payload: { code: '000000' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: h })).statusCode).toBe(403);

    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers: h, payload: { code: totpCode(secret) } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: h })).json().mfaEnrollmentRequired).toBe(false);
  });

  it('login de conta sem MFA também gera sessão limitada; com MFA exige o código antes de qualquer sessão', async () => {
    await register();
    const noMfa = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: PASSWORD } });
    expect(noMfa.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: { ...H, cookie: cookieOf(noMfa) } })).statusCode).toBe(403);

    const h = { ...H, cookie: cookieOf(noMfa) };
    const secret = (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers: h })).json().secret as string;
    await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers: h, payload: { code: totpCode(secret) } });

    const withoutCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: PASSWORD } });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.cookies.find((c) => c.name === 'ca_session')).toBeUndefined();
    const full = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: PASSWORD, totp: next(secret) } });
    expect(full.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: { ...H, cookie: cookieOf(full) } })).statusCode).toBe(200);
  });

  it('a entrada pelo Neon Auth não escapa da política', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: `Bearer ${await neonJwt('n-1', 'neon@example.com')}` }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: { ...H, cookie: cookieOf(res) } })).statusCode).toBe(403);
  });

  it('a API do Runner (token próprio) não depende da sessão de pessoa', async () => {
    const reg = await register();
    const h = { ...H, cookie: cookieOf(reg) };
    const secret = (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers: h })).json().secret as string;
    await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers: h, payload: { code: totpCode(secret) } });
    const runner = (await app.inject({ method: 'POST', url: '/api/v1/runners', headers: h, payload: { name: 'N' } })).json();
    const claim = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: { authorization: `Bearer ${runner.token}` } });
    expect(claim.statusCode).toBe(204);
  });
});

describe('anti-replay de TOTP', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await buildApp({ jobSigningKey: 'x'.repeat(40), production: false, logger: false }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('o mesmo código não vale duas vezes, nem o que já foi usado para ativar', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: 'O', email: 'a@example.com', password: PASSWORD } });
    const h = { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
    const secret = (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers: h })).json().secret as string;
    const activation = totpCode(secret);
    await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers: h, payload: { code: activation } });

    const login = (code: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'a@example.com', password: PASSWORD, totp: code } });
    expect((await login(activation)).statusCode).toBe(401); // código usado na ativação

    const fresh = next(secret);
    expect((await login(fresh)).statusCode).toBe(200);
    const replay = await login(fresh); // mesmo código de novo
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('invalid_mfa');
    expect((await login(next(secret, 2))).statusCode).toBe(401); // fora da janela de tolerância
  });
});
