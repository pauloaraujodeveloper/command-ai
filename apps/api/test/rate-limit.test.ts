import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadEnvFiles } from '../src/env.ts';
import { FallbackLimiter, MemoryLimiter, RedisLimiter, type AttemptLimiter } from '../src/rate-limit.ts';

loadEnvFiles();
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function redisUp(url: string): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1500 });
  r.on('error', () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const HAS_REDIS = await redisUp(REDIS_URL);
const prefix = () => `ca-test-rl-${randomBytes(4).toString('hex')}`;

describe('MemoryLimiter', () => {
  it('bloqueia depois do máximo de falhas e libera ao zerar', async () => {
    const l = new MemoryLimiter({ max: 3, windowMs: 60_000 });
    for (let i = 0; i < 2; i++) await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(false);
    await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(true);
    expect(await l.isLimited('outra')).toBe(false); // chaves independentes
    await l.reset('k');
    expect(await l.isLimited('k')).toBe(false);
  });
  it('a janela expira', async () => {
    let now = 1_000;
    const l = new MemoryLimiter({ max: 2, windowMs: 100, now: () => now });
    await l.registerFailure('k');
    await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(true);
    now += 101;
    expect(await l.isLimited('k')).toBe(false);
    await l.registerFailure('k'); // recomeça a contar
    expect(await l.isLimited('k')).toBe(false);
  });
  it('a memória é limitada: muitas chaves distintas não crescem sem fim', async () => {
    const l = new MemoryLimiter({ max: 3, windowMs: 60_000, maxKeys: 50 });
    for (let i = 0; i < 500; i++) await l.registerFailure(`ip-${i}`);
    expect(l.size()).toBeLessThanOrEqual(50);
  });
});

describe.skipIf(!HAS_REDIS)('RedisLimiter (Redis real)', () => {
  const closers: Array<() => Promise<void>> = [];
  const mk = (p: string, over: { max?: number; windowMs?: number } = {}) => {
    const l = new RedisLimiter({ url: REDIS_URL, max: over.max ?? 3, windowMs: over.windowMs ?? 60_000, prefix: p, commandTimeoutMs: 15_000 }); // folgado: com a suíte inteira rodando, 1,5 s podia estourar
    closers.push(() => l.close());
    return l;
  };
  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
  });

  it('duas instâncias compartilham a mesma contagem', async () => {
    const p = prefix();
    const a = mk(p);
    const b = mk(p);
    await a.registerFailure('ip|ana@example.com');
    await b.registerFailure('ip|ana@example.com');
    expect(await a.isLimited('ip|ana@example.com')).toBe(false);
    await a.registerFailure('ip|ana@example.com');
    expect(await b.isLimited('ip|ana@example.com')).toBe(true);
    await b.reset('ip|ana@example.com');
    expect(await a.isLimited('ip|ana@example.com')).toBe(false);
  });

  it('falhas simultâneas não se perdem (contagem atômica)', async () => {
    const p = prefix();
    const a = mk(p, { max: 20 });
    const b = mk(p, { max: 20 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).registerFailure('k')));
    expect(await a.isLimited('k')).toBe(true); // 20 de 20
    const c = mk(prefix(), { max: 20 });
    await Promise.all(Array.from({ length: 19 }, () => c.registerFailure('k')));
    expect(await c.isLimited('k')).toBe(false); // 19 de 20
  });

  it('a janela expira no Redis', async () => {
    // Janela folgada e espera por condição: com a máquina carregada, 150 ms podiam vencer antes da primeira conferência.
    const l = mk(prefix(), { max: 1, windowMs: 1500 });
    await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(true);
    const end = Date.now() + 8_000;
    while ((await l.isLimited('k')) && Date.now() < end) await sleep(100);
    expect(await l.isLimited('k')).toBe(false);
  });

  it('o Redis guarda só um hash da chave: e-mail e IP não ficam em texto', async () => {
    const p = prefix();
    const l = mk(p);
    await l.registerFailure('203.0.113.9|pessoa@example.com');
    const r = new Redis(REDIS_URL);
    try {
      const keys = await r.keys(`${p}:*`);
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain('pessoa');
      expect(keys[0]).not.toContain('203.0.113.9');
      expect(await r.pttl(keys[0]!)).toBeGreaterThan(0); // sempre com validade: nunca fica para sempre
    } finally {
      r.disconnect();
    }
  });
});

describe('FallbackLimiter', () => {
  const broken: AttemptLimiter = {
    isLimited: async () => {
      throw new Error('redis caiu');
    },
    registerFailure: async () => {
      throw new Error('redis caiu');
    },
    reset: async () => {
      throw new Error('redis caiu');
    },
  };

  it('com o Redis fora, continua limitando em memória (e avisa o erro)', async () => {
    const onError = vi.fn();
    const l = new FallbackLimiter(broken, new MemoryLimiter({ max: 2, windowMs: 60_000 }), onError);
    await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(false);
    await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(true); // o limite não some quando o Redis cai
    await l.reset('k');
    expect(await l.isLimited('k')).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('com o Redis bom, não usa a memória', async () => {
    const mem = new MemoryLimiter({ max: 2, windowMs: 60_000 });
    const primary = new MemoryLimiter({ max: 2, windowMs: 60_000 });
    const l = new FallbackLimiter(primary, mem, () => undefined);
    await l.registerFailure('k');
    await l.registerFailure('k');
    expect(await l.isLimited('k')).toBe(true);
    expect(mem.size()).toBe(0);
  });
});

describe.skipIf(!HAS_REDIS)('login com duas instâncias da API e um limitador compartilhado', () => {
  const apps: FastifyInstance[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await Promise.all(closers.splice(0).map((c) => c()));
  });
  const H = { 'x-command-ai': '1', 'content-type': 'application/json' };

  async function instance(p: string) {
    const limiter = new RedisLimiter({ url: REDIS_URL, max: 10, windowMs: 60_000, prefix: p, commandTimeoutMs: 15_000 });
    closers.push(() => limiter.close());
    const { app } = await buildApp({ jobSigningKey: 'rate-limit-test-signing-key-long-12345', production: false, logger: false, attemptLimiter: limiter });
    apps.push(app);
    return app;
  }
  const login = (app: FastifyInstance, password: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password } });

  it('10 falhas divididas entre as instâncias bloqueiam a 11ª em qualquer uma; antes disso não', async () => {
    const p = prefix();
    const A = await instance(p);
    const B = await instance(p);
    // cada instância tem a própria memória: sem Redis cada uma toleraria 10 e o limite efetivo seria 20
    for (let i = 0; i < 10; i++) expect((await login(i % 2 ? A : B, 'errada-errada-1')).statusCode).toBe(401);
    expect((await login(A, 'errada-errada-1')).statusCode).toBe(429);
    expect((await login(B, 'errada-errada-1')).statusCode).toBe(429);
  }, 60_000);
});

describe('Redis fora do ar (de verdade)', () => {
  it('o login continua respondendo, sem travar, e o limite segue valendo em memória', async () => {
    const errors: unknown[] = [];
    const dead = new RedisLimiter({ url: 'redis://127.0.0.1:6399', max: 10, windowMs: 60_000, prefix: prefix(), onError: () => undefined });
    const limiter = new FallbackLimiter(dead, new MemoryLimiter({ max: 3, windowMs: 60_000 }), (e) => errors.push(e));
    const { app } = await buildApp({ jobSigningKey: 'rate-limit-test-signing-key-long-12345', production: false, logger: false, attemptLimiter: limiter });
    try {
      const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
      const started = Date.now();
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'x@example.com', password: 'errada-errada-1' } })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]); // 3 falhas permitidas (limite do teste), depois bloqueio
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await limiter.close();
    }
  }, 60_000);
});
