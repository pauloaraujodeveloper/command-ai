import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

/** Contador de falhas por chave (login, MFA). Assíncrono para poder ser compartilhado entre instâncias. */
export interface AttemptLimiter {
  isLimited(key: string): Promise<boolean>;
  registerFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  close?(): Promise<void>;
}

export interface LimiterOptions {
  max: number;
  windowMs: number;
}

/** Em memória do processo: serve de padrão e de reserva quando o Redis cai. */
export class MemoryLimiter implements AttemptLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: LimiterOptions & { maxKeys?: number; now?: () => number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  size(): number {
    return this.entries.size;
  }

  async isLimited(key: string): Promise<boolean> {
    const e = this.entries.get(key);
    return !!e && e.resetAt > this.now() && e.count >= this.max;
  }

  async registerFailure(key: string): Promise<void> {
    const now = this.now();
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) {
      if (this.entries.size >= this.maxKeys) this.prune(now);
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      e.count++;
    }
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Remove as janelas vencidas; se ainda estiver cheio, as mais antigas (um atacante com muitos IPs não enche a memória). */
  private prune(now: number): void {
    for (const [k, v] of this.entries) if (v.resetAt <= now) this.entries.delete(k);
    let excess = this.entries.size - Math.floor(this.maxKeys * 0.9);
    for (const k of this.entries.keys()) {
      if (excess-- <= 0) break;
      this.entries.delete(k);
    }
  }
}

// Soma atômica com validade: a janela começa na primeira falha e a chave nunca fica sem prazo.
const INCR_WITH_TTL = `local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c`;

/** Compartilhado entre todas as instâncias da API por Redis. O Redis só vê um hash da chave (sem e-mail nem IP em texto). */
export class RedisLimiter implements AttemptLimiter {
  private readonly redis: Redis;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly prefix: string;

  constructor(opts: LimiterOptions & { url: string; prefix?: string; onError?: (err: unknown) => void }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.prefix = opts.prefix ?? 'command-ai:rl';
    // Poucas tentativas e prazo curto: o login não pode ficar pendurado esperando um Redis fora do ar.
    this.redis = new Redis(opts.url, { maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 1_500 });
    this.redis.on('error', opts.onError ?? (() => undefined));
  }

  private k(key: string): string {
    return `${this.prefix}:${createHash('sha256').update(key).digest('hex')}`;
  }

  async isLimited(key: string): Promise<boolean> {
    const v = await this.redis.get(this.k(key));
    return v !== null && Number(v) >= this.max;
  }

  async registerFailure(key: string): Promise<void> {
    await this.redis.eval(INCR_WITH_TTL, 1, this.k(key), String(this.windowMs));
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.k(key));
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/**
 * Usa o limitador compartilhado e, se ele falhar (Redis fora), segue com o de memória do processo.
 * Escolha deliberada: não bloquear todos os logins por causa do Redis, mas também não ficar sem limite algum.
 */
export class FallbackLimiter implements AttemptLimiter {
  constructor(
    private readonly primary: AttemptLimiter,
    private readonly fallback: AttemptLimiter,
    private readonly onError: (err: unknown) => void,
  ) {}

  private async run<T>(op: (l: AttemptLimiter) => Promise<T>): Promise<T> {
    try {
      return await op(this.primary);
    } catch (err) {
      this.onError(err);
      return op(this.fallback);
    }
  }

  isLimited(key: string): Promise<boolean> {
    return this.run((l) => l.isLimited(key));
  }
  registerFailure(key: string): Promise<void> {
    return this.run((l) => l.registerFailure(key));
  }
  reset(key: string): Promise<void> {
    return this.run((l) => l.reset(key));
  }
  async close(): Promise<void> {
    await this.primary.close?.();
  }
}
