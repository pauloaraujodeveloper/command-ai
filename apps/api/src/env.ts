import { resolve } from 'node:path';

/** Carrega .env.local (gerado por `neon env pull` / `neon deploy`) e .env da raiz do monorepo. Não sobrescreve o ambiente. */
export function loadEnvFiles(): void {
  for (const name of ['.env.local', '.env.db-app', '.env']) {
    try {
      process.loadEnvFile(resolve(process.cwd(), '../..', name));
    } catch {
      /* arquivo ausente */
    }
  }
}

export const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Ajustes do orquestrador lidos do ambiente. A API e o Worker precisam usar os MESMOS valores
 * (quem cria o lease e quem o varre têm de concordar).
 */
export function orchestratorOptionsFromEnv(): { leaseMs?: number; backoffBaseMs?: number; backoffMaxMs?: number; maxExecutionMs?: number } {
  const num = (name: string) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} inválido: ${raw}`);
    return n;
  };
  const out: Record<string, number> = {};
  for (const [env, key] of [['LEASE_MS', 'leaseMs'], ['BACKOFF_BASE_MS', 'backoffBaseMs'], ['BACKOFF_MAX_MS', 'backoffMaxMs'], ['MAX_EXECUTION_MS', 'maxExecutionMs']] as const) {
    const v = num(env);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function schemaName(): string {
  const name = process.env.DB_SCHEMA ?? 'command_ai';
  if (!SCHEMA_RE.test(name)) throw new Error('DB_SCHEMA inválido: use letras minúsculas, números e _');
  return name;
}
