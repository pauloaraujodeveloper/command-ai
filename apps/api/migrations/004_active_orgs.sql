-- O Worker só precisa varrer organizações que têm execução em andamento.
-- Como o RLS impede o papel da aplicação de ver linhas de várias organizações de uma vez, a função (SECURITY DEFINER)
-- devolve apenas os ids dessas organizações, nada além disso.
CREATE OR REPLACE FUNCTION "__SCHEMA__".list_active_organization_ids() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT DISTINCT organization_id FROM "__SCHEMA__".records
         WHERE kind = 'execution' AND data->>'status' = 'running' AND organization_id IS NOT NULL
         ORDER BY 1 $$;

REVOKE ALL ON FUNCTION "__SCHEMA__".list_active_organization_ids() FROM PUBLIC;

CREATE INDEX IF NOT EXISTS executions_running_idx ON "__SCHEMA__".records (organization_id) WHERE kind = 'execution' AND data->>'status' = 'running';
