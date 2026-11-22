import type { EventEnvelope } from '@command-ai/shared';

export type BusListener = (event: EventEnvelope) => void;

/**
 * Canal de eventos ao vivo. O banco é a fonte da verdade (o cliente sempre recupera o que perdeu pelo número de sequência);
 * o barramento só diz "chegou algo novo". `LocalBus` vale dentro de um processo; o de Redis (redis-bus.ts) vale entre processos.
 */
export interface EventBus {
  publish(event: EventEnvelope): void | Promise<void>;
  subscribe(executionId: string, fn: BusListener): () => void;
  close?(): Promise<void>;
}

export class LocalBus implements EventBus {
  private subs = new Map<string, Set<BusListener>>();

  publish(event: EventEnvelope): void {
    for (const fn of [...(this.subs.get(event.executionId) ?? [])]) {
      try {
        fn(event);
      } catch {
        /* um ouvinte com defeito não afeta os outros */
      }
    }
  }

  subscribe(executionId: string, fn: BusListener): () => void {
    const set = this.subs.get(executionId) ?? new Set<BusListener>();
    set.add(fn);
    this.subs.set(executionId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(executionId);
    };
  }
}
