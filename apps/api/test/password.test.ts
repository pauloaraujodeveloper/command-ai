import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  DEFAULT_PASSWORD_PARAMS,
  hashPassword,
  needsRehash,
  setPasswordParams,
  verifyPassword,
} from '../src/auth.ts';
import type { Store } from '../src/store.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/** Hash no formato antigo (scrypt), como os usuários criados antes da migração. */
async function legacyScrypt(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${2 ** 15}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

describe('política de senha (Argon2id)', () => {
  it('o padrão de produção atende ao mínimo da OWASP (m >= 19 MiB, t >= 2, p >= 1)', () => {
    expect(DEFAULT_PASSWORD_PARAMS.memoryKiB).toBeGreaterThanOrEqual(19 * 1024);
    expect(DEFAULT_PASSWORD_PARAMS.iterations).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_PASSWORD_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
  });

  it('gera hash argon2id com sal único e verifica senha certa e errada', async () => {
    const a = await hashPassword('senha-forte-123');
    const b = await hashPassword('senha-forte-123');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('senha-forte-123', a)).toBe(true);
    expect(await verifyPassword('senha-forte-124', a)).toBe(false);
  });

  it('continua verificando hashes antigos em scrypt', async () => {
    const old = await legacyScrypt('senha-antiga-1');
    expect(await verifyPassword('senha-antiga-1', old)).toBe(true);
    expect(await verifyPassword('outra', old)).toBe(false);
  });

  it('recusa formatos desconhecidos e hash vazio (conta só do Neon Auth)', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
    expect(await verifyPassword('x', '$argon2id$lixo')).toBe(false);
  });

  it('pede novo hash para scrypt e para argon2id com parâmetros mais fracos que o atual', async () => {
    expect(needsRehash(await legacyScrypt('x'))).toBe(true);
    const current = await hashPassword('x');
    expect(needsRehash(current)).toBe(false);
    setPasswordParams({ memoryKiB: 2048, iterations: 2, parallelism: 1 });
    expect(needsRehash(current)).toBe(true);
    setPasswordParams({ memoryKiB: 1024, iterations: 1, parallelism: 1 });
  });
});

describe('migração de hash no login', () => {
  let app: FastifyInstance;
  let store: Store;
  const H = { 'x-command-ai': '1', 'content-type': 'application/json' };

  beforeEach(async () => {
    ({ app, store } = await buildApp({ jobSigningKey: 'x'.repeat(40), production: false, logger: false }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('troca o hash scrypt por argon2id quando a senha confere, sem pedir nada ao usuário', async () => {
    const org = store.organizations.insert({ id: 'o1', name: 'Antiga' });
    const user = store.users.insert({
      id: 'u1',
      organizationId: org.id,
      name: 'Ana',
      email: 'ana@example.com',
      role: 'owner',
      passwordHash: await legacyScrypt('senha-antiga-123'),
      mfaSecret: null,
      mfaEnabled: false,
      createdAt: new Date().toISOString(),
    });

    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: 'errada-errada' } });
    expect(bad.statusCode).toBe(401);
    expect(store.users.get(user.id)!.passwordHash.startsWith('scrypt$')).toBe(true); // senha errada não migra

    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: 'senha-antiga-123' } });
    expect(ok.statusCode).toBe(200);
    expect(store.users.get(user.id)!.passwordHash).toMatch(/^\$argon2id\$/);

    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: 'senha-antiga-123' } });
    expect(again.statusCode).toBe(200);
  });

  it('novas contas já nascem com argon2id', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'N', orgName: 'O', email: 'n@example.com', password: 'senha-muito-forte-1' } });
    const u = store.users.filter((x) => x.email === 'n@example.com')[0]!;
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
  });
});
