import { createPool } from './db.ts';
import { loadEnvFiles, orchestratorOptionsFromEnv, schemaName } from './env.ts';
import { PgRepo } from './pg-repo.ts';
import { RedisBus } from './redis-bus.ts';
import { runSweep } from './sweep.ts';
import { BullMqEngine, IntervalEngine, type WorkflowEngine } from './workflow.ts';

/**
 * Worker de segundo plano: processo próprio, sem porta HTTP (no Render, "Background Worker").
 * Faz a recuperação: devolve à fila as tarefas cujo Runner sumiu e encerra execuções que passaram do prazo.
 * Pode haver vários Workers: cada ciclo roda uma vez no total (BullMQ) e a trava por organização impede conflito.
 */
loadEnvFiles();

const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) {
  console.error('O Worker precisa do PostgreSQL: defina DATABASE_URL (e DATABASE_URL_APP). Rode `neon env pull` e `pnpm db:create-app-role`.');
  process.exit(1);
}
const runtimeUrl = process.env.DATABASE_URL_APP;
if (!runtimeUrl) {
  const msg = 'DATABASE_URL_APP ausente: o Worker usaria o dono do schema, que ignora o RLS. Rode `pnpm db:create-app-role`.';
  if (production && process.env.ALLOW_DB_WITHOUT_RLS !== 'true') {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`[aviso] ${msg}`);
}

const redisUrl = process.env.REDIS_URL;
const log = (message: string, err?: unknown) => console.error(`[worker] ${message}`, err instanceof Error ? err.message : (err ?? ''));
const intervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 15_000);

const bus = redisUrl ? new RedisBus({ url: redisUrl, onError: (e) => log('Redis (eventos)', e) }) : undefined;
const repo = new PgRepo({
  pool: createPool(runtimeUrl ?? process.env.DATABASE_URL),
  schema: schemaName(),
  orchestrator: orchestratorOptionsFromEnv(),
  bus,
  onError: log,
});

const engine: WorkflowEngine = redisUrl
  ? new BullMqEngine({ redisUrl, intervalMs, onError: (e) => log('fila', e) })
  : new IntervalEngine({ intervalMs, onError: (e) => log('varredura', e) });

await engine.start(async () => {
  const s = await runSweep(repo, { log });
  if (s.requeued || s.failed || s.expiredExecutions || s.errors) {
    console.log(`[worker] varredura: ${s.requeued} devolvidas à fila, ${s.failed} falhas definitivas, ${s.expiredExecutions} execuções fora do prazo, ${s.errors} erros (${s.orgs} organizações)`);
  }
});
// No boot, recupera já: não espera o primeiro ciclo (um reinício do Worker não deixa tarefas órfãs esperando).
await engine.triggerSweep();

console.log(`Worker no ar: varredura a cada ${intervalMs / 1000} s via ${redisUrl ? 'BullMQ (Redis)' : 'relógio em processo (sem Redis)'}; PostgreSQL${runtimeUrl ? ' com papel restrito (RLS)' : ''}.`);

const shutdown = async (signal: string) => {
  console.log(`[worker] ${signal}: encerrando.`);
  await engine.close(); // termina a varredura em curso (cada organização confirma a própria transação)
  await repo.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
