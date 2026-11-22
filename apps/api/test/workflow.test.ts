import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { BullMqEngine, IntervalEngine, type WorkflowEngine } from '../src/workflow.ts';
import { loadEnvFiles } from '../src/env.ts';

loadEnvFiles();

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function redisUp(url: string): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1500 });
  r.on('error', () => undefined);
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const HAS_REDIS = await redisUp(REDIS_URL);

describe('IntervalEngine (sem Redis)', () => {
  it('roda a varredura a cada intervalo, sob demanda, e sobrevive a erros', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const engine: WorkflowEngine = new IntervalEngine({ intervalMs: 80, onError: (e) => errors.push(e) });
    await engine.start(async () => {
      calls++;
      if (calls === 1) throw new Error('falha de teste');
    });
    await sleep(400);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(errors).toHaveLength(1); // o erro foi registrado e o relógio continuou
    const before = calls;
    await engine.triggerSweep();
    expect(calls).toBe(before + 1);
    await engine.close();
    const after = calls;
    await sleep(250);
    expect(calls).toBe(after); // parou de verdade
  });

  it('não sobrepõe varreduras: se uma ainda está rodando, a seguinte espera', async () => {
    let running = 0;
    let maxRunning = 0;
    const engine = new IntervalEngine({ intervalMs: 30 });
    await engine.start(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(120);
      running--;
    });
    await sleep(500);
    await engine.close();
    expect(maxRunning).toBe(1);
  });
});

describe.skipIf(!HAS_REDIS)('BullMqEngine (Redis real)', () => {
  const prefix = `ca-test-${randomBytes(4).toString('hex')}`;
  const engines: BullMqEngine[] = [];
  const make = (intervalMs: number, onError?: (e: unknown) => void) => {
    const e = new BullMqEngine({ redisUrl: REDIS_URL, intervalMs, prefix, queueName: 'orchestration', onError });
    engines.push(e);
    return e;
  };

  afterAll(async () => {
    await Promise.all(engines.map((e) => e.close().catch(() => undefined)));
    // Limpa as chaves de teste do Redis.
    const r = new Redis(REDIS_URL);
    const keys = await r.keys(`${prefix}:*`);
    if (keys.length) await r.del(...keys);
    r.disconnect();
  });

  it('agenda a varredura periódica e a executa várias vezes', async () => {
    let calls = 0;
    const engine = make(250);
    await engine.start(async () => void calls++);
    await sleep(1600);
    expect(calls).toBeGreaterThanOrEqual(3);
    await engine.close();
  }, 30_000);

  it('triggerSweep executa já, sem esperar o próximo ciclo', async () => {
    const p = `${prefix}-t`;
    let calls = 0;
    const engine = new BullMqEngine({ redisUrl: REDIS_URL, intervalMs: 60_000, prefix: p, queueName: 'orchestration' });
    engines.push(engine);
    await engine.start(async () => void calls++);
    const t0 = Date.now();
    await engine.triggerSweep();
    for (let i = 0; i < 40 && calls === 0; i++) await sleep(50);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t0).toBeLessThan(3_000);
    await engine.close();
  }, 30_000);

  it('dois Workers na mesma fila não duplicam: cada ciclo roda uma vez no total', async () => {
    const p = `${prefix}-d`;
    const seen: string[] = [];
    const mk = (name: string) => {
      const e = new BullMqEngine({ redisUrl: REDIS_URL, intervalMs: 400, prefix: p, queueName: 'orchestration' });
      engines.push(e);
      return { e, name };
    };
    const w1 = mk('w1');
    const w2 = mk('w2');
    await w1.e.start(async () => void seen.push(w1.name));
    await w2.e.start(async () => void seen.push(w2.name));
    await sleep(2_200); // ~5 ciclos de 400 ms
    await w1.e.close();
    await w2.e.close();
    // Com duplicação seriam ~10 execuções. Uma por ciclo dá ~5 (alguma folga para a partida).
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.length).toBeLessThanOrEqual(7);
  }, 30_000);

  it('um erro na varredura não derruba o Worker: o ciclo seguinte roda', async () => {
    const p = `${prefix}-e`;
    const errors: unknown[] = [];
    let calls = 0;
    const engine = new BullMqEngine({ redisUrl: REDIS_URL, intervalMs: 250, prefix: p, queueName: 'orchestration', onError: (e) => errors.push(e) });
    engines.push(engine);
    await engine.start(async () => {
      calls++;
      if (calls === 1) throw new Error('falha de teste');
    });
    await sleep(1500);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    await engine.close();
  }, 30_000);

  it('depois de close() nada mais executa', async () => {
    const p = `${prefix}-c`;
    let calls = 0;
    const engine = new BullMqEngine({ redisUrl: REDIS_URL, intervalMs: 150, prefix: p, queueName: 'orchestration' });
    engines.push(engine);
    await engine.start(async () => void calls++);
    await sleep(700);
    await engine.close();
    const after = calls;
    await sleep(600);
    expect(calls).toBe(after);
  }, 30_000);
});
