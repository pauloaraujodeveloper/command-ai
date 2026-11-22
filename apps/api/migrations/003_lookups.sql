-- Buscas anteriores à autenticação e índices de apoio à unidade de trabalho.
--
-- Antes de saber a organização (login, sessão, token de Runner) a API não pode pôr o contexto do RLS.
-- Estas funções rodam com os direitos do dono e devolvem apenas o registro pedido por uma chave única e secreta
-- (hash de token, e-mail, sub do Neon). Depois da busca, tudo acontece no contexto da organização encontrada.

CREATE OR REPLACE FUNCTION "__SCHEMA__".find_session(p_id text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT data FROM "__SCHEMA__".records WHERE kind = 'session' AND id = p_id $$;

CREATE OR REPLACE FUNCTION "__SCHEMA__".find_runner_by_token_hash(p_hash text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT data FROM "__SCHEMA__".records
         WHERE kind = 'runner' AND data->>'tokenHash' = p_hash AND COALESCE((data->>'revoked')::boolean, false) = false $$;

CREATE OR REPLACE FUNCTION "__SCHEMA__".find_user_by_email(p_email text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT data FROM "__SCHEMA__".records WHERE kind = 'user' AND data->>'email' = p_email $$;

CREATE OR REPLACE FUNCTION "__SCHEMA__".find_user_by_neon_sub(p_sub text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT data FROM "__SCHEMA__".records WHERE kind = 'user' AND data->>'neonAuthId' = p_sub $$;

REVOKE ALL ON FUNCTION "__SCHEMA__".find_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".find_runner_by_token_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".find_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "__SCHEMA__".find_user_by_neon_sub(text) FROM PUBLIC;

-- E-mail e identidade do Neon são únicos no sistema inteiro (o RLS não afeta a unicidade dos índices).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON "__SCHEMA__".records ((data->>'email')) WHERE kind = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS users_neon_uq ON "__SCHEMA__".records ((data->>'neonAuthId')) WHERE kind = 'user' AND data ? 'neonAuthId';
CREATE INDEX IF NOT EXISTS runners_hash_idx ON "__SCHEMA__".records ((data->>'tokenHash')) WHERE kind = 'runner';
CREATE INDEX IF NOT EXISTS tasks_queued_idx ON "__SCHEMA__".records (organization_id) WHERE kind = 'task' AND data->>'status' = 'queued';
