import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createNeonVerifier } from '../src/neon-auth.ts';

const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const PASSWORD = 'senha-muito-forte-1';
const BASE = 'https://ep-allow.neonauth.example.neon.tech/neondb/auth';

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1' };
});
const neonJwt = (sub: string, email: string) =>
  new SignJWT({ email, name: 'Neon' }).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setSubject(sub).setIssuer(new URL(BASE).origin).setIssuedAt().setExpirationTime('10m').sign(privateKey);

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});
const make = async (registrationAllowedEmails?: string[]) => {
  const jwks = createLocalJWKSet({ keys: [publicJwk as never] });
  ({ app } = await buildApp({
    jobSigningKey: 'x'.repeat(40),
    production: false,
    registrationAllowedEmails,
    neonAuth: createNeonVerifier({ baseUrl: BASE, jwksUrl: `${BASE}/.well-known/jwks.json`, getKey: jwks }),
  }));
};
const register = (email: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'Paulo', orgName: 'Org', email, password: PASSWORD } });

describe('cadastro restrito a e-mails autorizados (registrationAllowedEmails)', () => {
  it('sem a lista, qualquer e-mail pode se cadastrar (comportamento padrão)', async () => {
    await make();
    expect((await register('qualquer@example.com')).statusCode).toBe(201);
  });

  it('com a lista, só os e-mails dela se cadastram, sem diferenciar maiúsculas, e viram owner', async () => {
    await make(['Dono@Example.com']);
    const ok = await register('dono@example.com');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user.role).toBe('owner');
  });

  it('com a lista, outro e-mail é recusado com 403 e a resposta não revela a lista', async () => {
    await make(['dono@example.com']);
    const res = await register('intruso@example.com');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('dono@example.com');
    // Nada foi criado: o login do intruso também falha.
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'intruso@example.com', password: PASSWORD } });
    expect(login.statusCode).toBe(401);
  });

  it('lista vazia ou só com espaços equivale a "sem lista"', async () => {
    await make(['  ', '']);
    expect((await register('qualquer@example.com')).statusCode).toBe(201);
  });

  it('o primeiro acesso pelo Neon Auth também respeita a lista', async () => {
    await make(['dono@example.com']);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: `Bearer ${await neonJwt('sub-1', 'intruso@example.com')}` }, payload: {} });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: `Bearer ${await neonJwt('sub-2', 'dono@example.com')}` }, payload: {} });
    expect(good.statusCode).toBe(200);
  });
});
