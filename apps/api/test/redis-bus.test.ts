import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@command-ai/shared';
import { loadEnvFiles } from '../src/env.ts';
import { RedisBus } from '../src/redis-bus.ts';

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

const ev = (executionId: string, seq: number): EventEnvelope => ({
  id: `e-${seq}`,
  seq,
  executionId,
  taskId: null,
  type: 'log.appended',
  version: 1,
  ts: '2026-01-01T00:00:00.000Z',
  payload: { line: `linha ${seq}`, acentos: 'çã✓' },
});

describe.skipIf(!HAS_REDIS)('RedisBus: eventos ao vivo entre processos', () => {
  const channel = `ca-test-bus-${randomBytes(4).toString('hex')}`;
  const buses: RedisBus[] = [];
  const make = () => {
    const b = new RedisBus({ url: REDIS_URL, channel });
    buses.push(b);
    return b;
  };
  afterAll(async () => {
    await Promise.all(buses.map((b) => b.close()));
  });

  it('o evento publicado por um processo chega a quem assiste no outro, intacto', async () => {
    const publisher = make();
    const watcher = make();
    await Promise.all([publisher.ready(), watcher.ready()]);
    const got: EventEnvelope[] = [];
    watcher.subscribe('exec-1', (e) => got.push(e));
    await publisher.publish(ev('exec-1', 1));
    for (let i = 0; i < 40 && got.length === 0; i++) await sleep(25);
    expect(got).toEqual([ev('exec-1', 1)]);
  });

  it('cada assinante só recebe a execução que assiste', async () => {
    const a = make();
    const b = make();
    await Promise.all([a.ready(), b.ready()]);
    const gotX: number[] = [];
    const gotY: number[] = [];
    b.subscribe('exec-x', (e) => gotX.push(e.seq));
    b.subscribe('exec-y', (e) => gotY.push(e.seq));
    await a.publish(ev('exec-x', 1));
    await a.publish(ev('exec-y', 7));
    await a.publish(ev('exec-x', 2));
    for (let i = 0; i < 40 && gotX.length < 2; i++) await sleep(25);
    expect(gotX).toEqual([1, 2]);
    expect(gotY).toEqual([7]);
  });

  it('cancelar a assinatura para de entregar; vários ouvintes da mesma execução recebem todos', async () => {
    const a = make();
    const b = make();
    await Promise.all([a.ready(), b.ready()]);
    const one: number[] = [];
    const two: number[] = [];
    const off1 = b.subscribe('exec-z', (e) => one.push(e.seq));
    b.subscribe('exec-z', (e) => two.push(e.seq));
    await a.publish(ev('exec-z', 1));
    for (let i = 0; i < 40 && two.length < 1; i++) await sleep(25);
    off1();
    await a.publish(ev('exec-z', 2));
    for (let i = 0; i < 40 && two.length < 2; i++) await sleep(25);
    expect(one).toEqual([1]);
    expect(two).toEqual([1, 2]);
  });

  it('mensagem corrompida no canal é ignorada e não derruba o assinante', async () => {
    const a = make();
    const b = make();
    await Promise.all([a.ready(), b.ready()]);
    const got: number[] = [];
    b.subscribe('exec-bad', (e) => got.push(e.seq));
    const raw = new Redis(REDIS_URL);
    await raw.publish(channel, '{isso não é json');
    await raw.publish(channel, JSON.stringify({ sem: 'executionId' }));
    raw.disconnect();
    await a.publish(ev('exec-bad', 3));
    for (let i = 0; i < 40 && got.length === 0; i++) await sleep(25);
    expect(got).toEqual([3]);
  });
});
