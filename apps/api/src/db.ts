import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SCHEMA_RE } from './env.ts';

/**
 * node-postgres: o backend roda em um processo de longa duração (Render), então o pool é reaproveitado.
 * A aplicação usa a URL com pooler (DATABASE_URL); migrações usam a direta (DATABASE_URL_UNPOOLED).
 */
export function createPool(connectionString: string): pg.Pool {
  // `require` já é tratado como `verify-full` pelo pg; deixamos explícito para não depender da mudança de semântica do pg v9.
  const strict = connectionString.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full');
  const pool = new pg.Pool({ connectionString: strict, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  pool.on('error', (err) => console.error('[pg] erro em conexão ociosa:', err.message));
  return pool;
}

export const DEFAULT_APP_ROLE = 'command_ai_app';

/**
 * Concede ao papel da aplicação só o que ele precisa: usar o schema, ler e gravar nas tabelas e chamar a função de listagem.
 * Não concede DDL, nem acesso a schema_migrations. Idempotente; rode de novo depois de criar tabelas.
 * Use a conexão do dono do schema.
 */
export async function grantAppRole(pool: pg.Pool, schema: string, role: string = DEFAULT_APP_ROLE): Promise<void> {
  if (!SCHEMA_RE.test(schema) || !SCHEMA_RE.test(role)) throw new Error('Nome de schema ou papel inválido');
  const s = `"${schema}"`;
  const r = `"${role}"`;
  const client = await pool.connect();
  try {
    await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
    await client.query(`REVOKE ALL ON ${s}.schema_migrations FROM ${r}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`);
    for (const fn of ['list_organization_ids()', 'list_active_organization_ids()', 'find_session(text)', 'find_runner_by_token_hash(text)', 'find_user_by_email(text)', 'find_user_by_neon_sub(text)']) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
    }
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Aplica as migrações SQL pendentes (idempotente) no schema indicado. Use a conexão direta. */
export async function migrate(pool: pg.Pool, schema: string): Promise<string[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error('Nome de schema inválido');
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM "${schema}".schema_migrations`)).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = (await readFile(join(MIGRATIONS_DIR, file), 'utf8')).replaceAll('__SCHEMA__', schema);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO "${schema}".schema_migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
  return applied;
}
