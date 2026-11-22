import { Redis } from 'ioredis';
import type { EventEnvelope } from '@command-ai/shared';
import { LocalBus, type BusListener, type EventBus } from './bus.ts';

/**
 * Eventos ao vivo entre processos (API, Worker) por pub/sub do Redis.
 * O banco continua sendo a fonte da verdade: quem perde uma mensagem recupera pelo número de sequência.
 */
export class RedisBus implements EventBus {
  private pub: Redis;
  private sub: Redis;
  private local = new LocalBus();
  private readyPromise: Promise<void>;
  private readonly channel: string;

  constructor(opts: { url: string; channel?: string; onError?: (err: unknown) => void }) {
    this.channel = opts.channel ?? 'command-ai:events';
    const onError = opts.onError ?? (() => undefined);
    this.pub = new Redis(opts.url, { maxRetriesPerRequest: 2 });
    this.sub = new Redis(opts.url, { maxRetriesPerRequest: null });
    this.pub.on('error', onError);
    this.sub.on('error', onError);

    this.sub.on('message', (channel, message) => {
      if (channel !== this.channel) return;
      try {
        const event = JSON.parse(message) as EventEnvelope;
        // Mensagem fora do formato é ignorada: o canal é compartilhado e nunca confiamos no conteúdo.
        if (event && typeof event.executionId === 'string' && typeof event.seq === 'number') this.local.publish(event);
      } catch {
        /* JSON corrompido */
      }
    });
    // Assina já na criação: quando o primeiro cliente chegar a conexão está pronta (e reassina sozinha após quedas).
    this.readyPromise = this.sub.subscribe(this.channel).then(() => undefined);
    this.readyPromise.catch(onError);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async publish(event: EventEnvelope): Promise<void> {
    await this.pub.publish(this.channel, JSON.stringify(event));
  }

  subscribe(executionId: string, fn: BusListener): () => void {
    return this.local.subscribe(executionId, fn);
  }

  async close(): Promise<void> {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
