import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';
import { loadEnvFiles, orchestratorOptionsFromEnv, schemaName } from './env.ts';
import { createNeonVerifier } from './neon-auth.ts';
import { PgRepo } from './pg-repo.ts';
import { FallbackLimiter, MemoryLimiter, RedisLimiter, type AttemptLimiter } from './rate-limit.ts';
import { RedisBus } from './redis-bus.ts';
import type { Repo } from './repo.ts';
import { runSweep } from './sweep.ts';
import { IntervalEngine } from './workflow.ts';

// .env.local (gerado pela Neon), .env.db-app (papel restrito) e .env da raiz do monorepo.
loadEnvFiles();

const production = process.env.NODE_ENV === 'production';
const DEV_KEY = 'dev-only-signing-key-change-me-000000000000';
const jobSigningKey = process.env.JOB_SIGNING_KEY ?? (production ? '' : DEV_KEY);

if (production && jobSigningKey.length < 32) {
  console.error('JOB_SIGNING_KEY é obrigatório em produção (mínimo de 32 caracteres).');
  process.exit(1);
}
if (jobSigningKey === DEV_KEY) {
  console.warn('[aviso] Usando a chave de assinatura de desenvolvimento. Defina JOB_SIGNING_KEY fora do ambiente local.');
}

/* ---- PostgreSQL (Neon): o estado vive no banco; sem DATABASE_URL a API roda em memória ---- */
let repo: Repo | undefined;
if (process.env.DATABASE_URL && process.env.COMMAND_AI_STORAGE !== 'memory') {
  // Em execução a API usa o papel restrito (RLS valendo). O dono do schema (DATABASE_URL) tem BYPASSRLS e fica só para migrações.
  const runtimeUrl = process.env.DATABASE_URL_APP;
  if (!runtimeUrl) {
    const msg = 'DATABASE_URL_APP ausente: a API usaria o dono do schema, que ignora o RLS. Rode `pnpm db:create-app-role`.';
    if (production && process.env.ALLOW_DB_WITHOUT_RLS !== 'true') {
      console.error(`${msg} (ALLOW_DB_WITHOUT_RLS=true força, não recomendado.)`);
      process.exit(1);
    }
    console.warn(`[aviso] ${msg}`);
  }
  const pool = createPool(runtimeUrl ?? process.env.DATABASE_URL);
  try {
    await pool.query('SELECT 1');
    // Confere que as migrações foram aplicadas, para falhar cedo e com uma mensagem útil.
    await pool.query(`SELECT "${schemaName()}".list_organization_ids() LIMIT 0`);
  } catch (err) {
    console.error('Falha ao conectar ao PostgreSQL. Rode `pnpm db:migrate` e `pnpm db:create-app-role` e confira as credenciais.', err instanceof Error ? err.message : err);
    process.exit(1);
  }
  // Com Redis, os eventos ao vivo chegam a clientes ligados em qualquer instância da API (inclusive os gerados pelo Worker).
  const bus = process.env.REDIS_URL ? new RedisBus({ url: process.env.REDIS_URL, onError: (e) => console.error('[redis]', e instanceof Error ? e.message : e) }) : undefined;
  repo = new PgRepo({ pool, schema: schemaName(), orchestrator: orchestratorOptionsFromEnv(), bus });
  console.log(`PostgreSQL conectado${runtimeUrl ? ' (papel restrito, RLS ativo)' : ''}. Estado no banco; a API não guarda estado em memória. Eventos ao vivo: ${bus ? 'Redis' : 'só nesta instância (defina REDIS_URL para várias)'}.`);
} else {
  console.warn('[aviso] Sem DATABASE_URL: os dados ficam só em memória e somem ao reiniciar.');
}

/* ---- Limite de tentativas de login e MFA: compartilhado entre instâncias quando há Redis ---- */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
let attemptLimiter: AttemptLimiter | undefined;
if (process.env.REDIS_URL) {
  let lastWarn = 0;
  const onError = (e: unknown) => {
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      console.error('[redis] limite de login: usando a memória deste processo enquanto o Redis não responde:', e instanceof Error ? e.message : e);
    }
  };
  attemptLimiter = new FallbackLimiter(
    new RedisLimiter({ url: process.env.REDIS_URL, max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS, onError }),
    new MemoryLimiter({ max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS }),
    onError,
  );
  console.log('Limite de tentativas de login compartilhado entre instâncias (Redis).');
} else {
  console.warn('[aviso] Sem REDIS_URL: o limite de tentativas de login vale por processo (com N instâncias, o limite efetivo é N vezes maior).');
}

/* ---- Neon Auth ---- */
const neonAuth =
  process.env.NEON_AUTH_BASE_URL && process.env.NEON_AUTH_JWKS_URL
    ? createNeonVerifier({ baseUrl: process.env.NEON_AUTH_BASE_URL, jwksUrl: process.env.NEON_AUTH_JWKS_URL })
    : undefined;

/* ---- App web na mesma origem (produção e app desktop): serve apps/web/dist se existir ---- */
const webDistCandidate = process.env.WEB_DIST ?? resolve(process.cwd(), '../web/dist');
const webDist = existsSync(resolve(webDistCandidate, 'index.html')) ? webDistCandidate : undefined;
if (webDist) console.log(`Servindo o app web de ${webDist}`);

/* ---- MFA obrigatório: ligado por padrão em produção; REQUIRE_MFA=true/false força o valor ---- */
const requireMfa = process.env.REQUIRE_MFA ? process.env.REQUIRE_MFA === 'true' : production;
if (production && !requireMfa) console.warn('[aviso] REQUIRE_MFA=false em produção: contas sem MFA terão acesso completo.');

const built = await buildApp({ attemptLimiter, jobSigningKey, production, repo, neonAuth, webDist, neonAuthBaseUrl: process.env.NEON_AUTH_BASE_URL, requireMfa, orchestrator: orchestratorOptionsFromEnv() });
const { app } = built;
const port = Number(process.env.PORT ?? 3011);
const host = process.env.HOST ?? '127.0.0.1';

/* ---- Recuperação dentro da própria API: só em memória (desenvolvimento) ou com SWEEP_IN_PROCESS=true ----
   Com PostgreSQL e Worker separado (`pnpm worker`), deixe desligado: o Worker cuida disso. */
let sweepEngine: IntervalEngine | undefined;
if (built.repo.kind === 'memory' || process.env.SWEEP_IN_PROCESS === 'true') {
  sweepEngine = new IntervalEngine({ intervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 15_000), onError: (e) => app.log.error(e) });
  await sweepEngine.start(async () => void (await runSweep(built.repo, { log: (m, e) => app.log.error({ err: e }, m) })));
  console.log('Recuperação de tarefas rodando dentro da API (sem Worker separado).');
}

const shutdown = async (signal: string) => {
  app.log.info(`Recebido ${signal}; encerrando.`);
  await sweepEngine?.close();
  await attemptLimiter?.close?.();
  await app.close(); // termina as requisições em curso (cada uma confirma a própria transação) e fecha o pool
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host });
