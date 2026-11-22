import { createPool, migrate } from './db.ts';
import { loadEnvFiles, schemaName } from './env.ts';

loadEnvFiles();

// Migrações usam a conexão direta (sem pooler), conforme as boas práticas da Neon.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Defina DATABASE_URL_UNPOOLED (ou DATABASE_URL). Rode `neon env pull` na raiz.');
  process.exit(1);
}

const pool = createPool(url);
try {
  const schema = schemaName();
  const applied = await migrate(pool, schema);
  console.log(applied.length ? `Migrações aplicadas em "${schema}": ${applied.join(', ')}` : `Schema "${schema}" já está atualizado.`);
} finally {
  await pool.end();
}
