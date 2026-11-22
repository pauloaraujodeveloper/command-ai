import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, DEFAULT_APP_ROLE, grantAppRole } from './db.ts';
import { loadEnvFiles, SCHEMA_RE, schemaName } from './env.ts';

/**
 * Cria (ou atualiza) o papel de banco que a API usa em execução, sem BYPASSRLS, e grava a credencial em .env.db-app.
 * Rode como o dono do schema: usa DATABASE_URL_UNPOOLED. Idempotente; `--rotate` gera uma senha nova.
 */
loadEnvFiles();

const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const pooledUrl = process.env.DATABASE_URL ?? ownerUrl;
const role = process.env.DB_APP_ROLE ?? DEFAULT_APP_ROLE;
const rotate = process.argv.includes('--rotate');
const envFile = resolve(process.cwd(), '../..', '.env.db-app');

if (!ownerUrl || !pooledUrl) {
  console.error('Defina DATABASE_URL_UNPOOLED e DATABASE_URL (rode `neon env pull` na raiz).');
  process.exit(1);
}
if (!SCHEMA_RE.test(role)) {
  console.error('DB_APP_ROLE inválido: use letras minúsculas, números e _.');
  process.exit(1);
}

const pool = createPool(ownerUrl);
try {
  const exists = (await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
  const haveCredential = existsSync(envFile);
  const needPassword = !exists || rotate || !haveCredential;

  if (needPassword) {
    const password = randomBytes(24).toString('base64url'); // só [A-Za-z0-9_-]: seguro como literal em CREATE/ALTER ROLE
    if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new Error('Senha gerada fora do alfabeto esperado');
    const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
    await pool.query(exists ? `ALTER ROLE "${role}" WITH ${attrs} PASSWORD '${password}'` : `CREATE ROLE "${role}" WITH ${attrs} PASSWORD '${password}'`);

    const url = new URL(pooledUrl); // conexão com pooler: é a que a aplicação usa
    url.username = role;
    url.password = password;
    writeFileSync(envFile, `# Gerado por \`pnpm db:create-app-role\`. Credencial do papel ${role} (sem BYPASSRLS). Não versione.\nDATABASE_URL_APP="${url.toString()}"\n`, { mode: 0o600 });
    console.log(`${exists ? 'Senha do papel renovada' : 'Papel criado'}: ${role}. Credencial gravada em .env.db-app.`);
  } else {
    console.log(`Papel ${role} já existe e .env.db-app está presente; senha mantida (use --rotate para trocar).`);
  }

  const attrs = (await pool.query('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1', [role])).rows[0];
  console.log('Atributos:', JSON.stringify(attrs));
  if (attrs.rolbypassrls || attrs.rolsuper) throw new Error('O papel não pode ter BYPASSRLS nem ser superusuário.');

  const schema = schemaName();
  await grantAppRole(pool, schema, role);
  console.log(`Permissões concedidas no schema "${schema}".`);
} finally {
  await pool.end();
}
