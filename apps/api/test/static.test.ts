import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let root: string;
const NEON = 'https://ep-x.neonauth.c-2.sa-east-1.aws.neon.tech/neondb/auth';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ca-static-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Command AI</title><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'sw.js'), '// sw');
  writeFileSync(join(root, 'secret.txt'), 'SEGREDO-FORA-DA-PASTA');
  ({ app } = await buildApp({ jobSigningKey: 'x'.repeat(40), production: false, logger: false, webDist: dist, neonAuthBaseUrl: NEON }));
});
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('servindo o app web pelo mesmo servidor', () => {
  it('entrega o index.html na raiz com CSP que permite o app e o Neon Auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://ep-x.neonauth.c-2.sa-east-1.aws.neon.tech');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('faz fallback de rotas do app (SPA) para o index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/execucoes/abc' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root">');
  });

  it('cacheia arquivos com hash por um ano e nunca cacheia o service worker', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.headers['cache-control']).toBe('no-cache');
  });

  it('mantém a API em JSON com CSP restrita e 404 em problem+json', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(String(health.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(health.headers['cache-control']).toBe('no-store');
    const nope = await app.inject({ method: 'GET', url: '/api/v1/nao-existe' });
    expect(nope.statusCode).toBe(404);
    expect(nope.headers['content-type']).toMatch(/problem\+json/);
  });

  it('não escapa da pasta com path traversal', async () => {
    for (const url of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain('SEGREDO-FORA-DA-PASTA');
    }
  });

  it('não responde a métodos que alteram dados fora da API com o index.html', async () => {
    const res = await app.inject({ method: 'POST', url: '/qualquer', headers: { 'x-command-ai': '1' } });
    expect(res.statusCode).toBe(404);
  });
});
