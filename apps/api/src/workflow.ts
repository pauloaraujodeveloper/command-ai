import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Motor das tarefas ligadas ao tempo: varredura periódica de leases vencidos e de prazos de execução.
 *
 * A entrega de tarefas ao Runner NÃO passa por aqui: ela é atômica no PostgreSQL (trava por organização), então perder o
 * Redis nunca perde uma tarefa. O motor só decide QUANDO rodar a varredura e garante que, com vários Workers, cada ciclo
 * rode uma vez no total. É a interface `WorkflowEngine` prevista no PRD: dá para trocar o BullMQ sem mexer no orquestrador.
 */
export type SweepHandler = () => Promise<void>;

export interface WorkflowEngine {
  /** Começa a rodar: agenda a varredura periódica e passa a executar `onSweep`. */
  start(onSweep: SweepHandler): Promise<void>;
  /** Pede uma varredura agora, sem esperar o próximo ciclo (útil no boot, para recuperar já). */
  triggerSweep(): Promise<void>;
  close(): Promise<void>;
}

/** Sem Redis: um relógio em processo. Serve para desenvolvimento e para quem roda um único Worker. */
export class IntervalEngine implements WorkflowEngine {
  private timer?: ReturnType<typeof setInterval>;
  private handler?: SweepHandler;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(private opts: { intervalMs: number; onError?: (err: unknown) => void }) {}

  async start(onSweep: SweepHandler): Promise<void> {
    this.handler = onSweep;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  /** Nunca sobrepõe: se uma varredura ainda está rodando, esta é pulada. */
  private async tick(): Promise<void> {
    if (this.closed || !this.handler || this.running) return;
    this.running = (async () => {
      try {
        await this.handler!();
      } catch (err) {
        this.opts.onError?.(err);
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  triggerSweep(): Promise<void> {
    return this.tick();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.running; // deixa a varredura em curso terminar
  }
}

export interface BullMqEngineOptions {
  redisUrl: string;
  intervalMs: number;
  queueName?: string;
  /** Prefixo das chaves no Redis (isola ambientes que dividem o mesmo Redis). */
  prefix?: string;
  onError?: (err: unknown) => void;
}

/** BullMQ sobre Redis: um agendador único para todos os Workers, com retentativa e histórico do próprio job. */
export class BullMqEngine implements WorkflowEngine {
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private opts: BullMqEngineOptions) {}

  private connection(): ConnectionOptions {
    // maxRetriesPerRequest: null é exigido pelo BullMQ nas conexões bloqueantes do Worker.
    const r = new Redis(this.opts.redisUrl, { maxRetriesPerRequest: null });
    r.on('error', (err) => this.opts.onError?.(err));
    this.connections.push(r);
    return r as unknown as ConnectionOptions;
  }

  async start(onSweep: SweepHandler): Promise<void> {
    const name = this.opts.queueName ?? 'orchestration';
    const prefix = this.opts.prefix;
    this.queue = new Queue(name, { connection: this.connection(), ...(prefix ? { prefix } : {}) });
    this.queue.on('error', (err) => this.opts.onError?.(err));

    // O agendador tem id fixo: várias chamadas (vários Workers, vários boots) atualizam o mesmo agendamento, sem duplicar.
    await this.queue.upsertJobScheduler(
      'sweep',
      { every: this.opts.intervalMs },
      { name: 'sweep', opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } } },
    );

    this.worker = new Worker(
      name,
      async () => {
        await onSweep();
      },
      { connection: this.connection(), concurrency: 1, ...(prefix ? { prefix } : {}) },
    );
    this.worker.on('failed', (_job, err) => this.opts.onError?.(err));
    this.worker.on('error', (err) => this.opts.onError?.(err));
    await this.worker.waitUntilReady();
  }

  async triggerSweep(): Promise<void> {
    if (!this.queue) throw new Error('O motor ainda não foi iniciado');
    await this.queue.add('sweep-now', {}, { removeOnComplete: true, removeOnFail: { count: 100 } });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const c of this.connections) c.disconnect();
    this.connections = [];
  }
}
