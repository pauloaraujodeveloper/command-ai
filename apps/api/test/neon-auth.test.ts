import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { totpCode } from '../src/auth.ts';
import { createNeonVerifier, type NeonVerifier } from '../src/neon-auth.ts';

const BASE = 'https://ep-test.neonauth.example.neon.tech/neondb/auth';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };

let keys: { privateKey: CryptoKey; publicJwk: Record<string, unknown> };
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  keys = { privateKey: pair.privateKey, publicJwk: { ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1' } };
  otherKey = (await generateKeyPair('EdDSA')).privateKey;
});

function verifier(): NeonVerifier {
  const jwks = createLocalJWKSet({ keys: [keys.publicJwk as never] });
  return createNeonVerifier({ baseUrl: BASE, jwksUrl: `${BASE}/.well-known/jwks.json`, getKey: jwks });
}

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; issuer?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setSubject(String(claims.sub ?? 'user-1'))
    .setIssuer(opts.issuer ?? new URL(BASE).origin)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? keys.privateKey);
}

describe('createNeonVerifier', () => {
  it('aceita um JWT válido e extrai a identidade', async () => {
    const id = await verifier()(await token({ sub: 'u-1', email: 'Ana@Example.com', name: 'Ana' }));
    expect(id).toEqual({ sub: 'u-1', email: 'ana@example.com', name: 'Ana', emailVerified: false });
  });

  it('rejeita assinatura de outra chave', async () => {
    expect(await verifier()(await token({ sub: 'u-1', email: 'a@b.co' }, { key: otherKey }))).toBeNull();
  });

  it('rejeita emissor errado', async () => {
    expect(await verifier()(await token({ sub: 'u-1', email: 'a@b.co' }, { issuer: 'https://evil.example' }))).toBeNull();
  });

  it('rejeita token expirado', async () => {
    expect(await verifier()(await token({ sub: 'u-1', email: 'a@b.co' }, { exp: '-1m' }))).toBeNull();
  });

  it('rejeita token sem e-mail e lixo que não é JWT', async () => {
    expect(await verifier()(await token({ sub: 'u-1' }))).toBeNull();
    expect(await verifier()('nao-sou-um-jwt')).toBeNull();
  });
});

describe('POST /auth/neon/session', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildApp({ jobSigningKey: 'x'.repeat(40), production: false, logger: false, neonAuth: verifier() }));
  });
  afterEach(async () => {
    await app.close();
  });

  const exchange = async (jwt: string, body: object = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: `Bearer ${jwt}` }, payload: body });

  it('provisiona usuário e organização na primeira entrada e abre sessão HttpOnly', async () => {
    const res = await exchange(await token({ sub: 'u-1', email: 'ana@example.com', name: 'Ana' }));
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'ca_session');
    expect(cookie?.httpOnly).toBe(true);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `ca_session=${cookie!.value}` } });
    expect(me.json().user.email).toBe('ana@example.com');
    expect(me.json().user.role).toBe('owner');
  });

  it('reaproveita o mesmo usuário na segunda entrada', async () => {
    const jwt = await token({ sub: 'u-1', email: 'ana@example.com', name: 'Ana' });
    const a = (await exchange(jwt)).json().user.id;
    const b = (await exchange(jwt)).json().user.id;
    expect(a).toBe(b);
  });

  it('não assume uma conta local que tenha o mesmo e-mail', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'Vítima', orgName: 'V', email: 'vitima@example.com', password: 'senha-muito-forte-1' } });
    const res = await exchange(await token({ sub: 'atacante', email: 'vitima@example.com', name: 'X' }));
    expect(res.statusCode).toBe(409);
    expect(res.cookies.find((c) => c.name === 'ca_session')).toBeUndefined();
  });

  it('recusa token inválido e requisição sem token', async () => {
    expect((await exchange(await token({ sub: 'u', email: 'a@b.co' }, { key: otherKey }))).statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: H, payload: {} });
    expect(none.statusCode).toBe(401);
  });

  it('exige o TOTP quando a conta tem MFA ativo', async () => {
    const jwt = await token({ sub: 'u-9', email: 'mfa@example.com', name: 'Mfa' });
    const first = await exchange(jwt);
    const cookie = `ca_session=${first.cookies.find((c) => c.name === 'ca_session')!.value}`;
    const secret = (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers: { ...H, cookie } })).json().secret;
    await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers: { ...H, cookie }, payload: { code: totpCode(secret) } });

    const without = await exchange(jwt);
    expect(without.statusCode).toBe(401);
    expect(without.json().code).toBe('mfa_required');
    expect((await exchange(jwt, { totp: totpCode(secret, Date.now() + 30_000) })).statusCode).toBe(200); // janela seguinte: o código da ativação já foi usado
  });

  it('fica desativada (501) quando o servidor não tem Neon Auth configurado', async () => {
    const { app: plain } = await buildApp({ jobSigningKey: 'x'.repeat(40), production: false, logger: false });
    const res = await plain.inject({ method: 'POST', url: '/api/v1/auth/neon/session', headers: { ...H, authorization: 'Bearer x' }, payload: {} });
    expect(res.statusCode).toBe(501);
    await plain.close();
  });
});
