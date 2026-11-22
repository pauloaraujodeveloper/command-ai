-- Isolamento por organização no banco (RLS).
-- A API define `app.organization_id` com set_config(..., true) dentro de cada transação.
-- As políticas valem para papéis SEM o atributo BYPASSRLS (o papel command_ai_app, ver `pnpm db:create-app-role`).
-- O dono do schema (neondb_owner) tem BYPASSRLS no Neon e continua ignorando as políticas: use-o só para migrações.

ALTER TABLE "__SCHEMA__".events ADD COLUMN IF NOT EXISTS organization_id text;

UPDATE "__SCHEMA__".events e
   SET organization_id = r.organization_id
  FROM "__SCHEMA__".records r
 WHERE r.kind = 'execution' AND r.id = e.execution_id AND e.organization_id IS NULL;

-- A linha da própria organização usa o id como organization_id.
UPDATE "__SCHEMA__".records SET organization_id = id WHERE kind = 'organization' AND organization_id IS NULL;

CREATE INDEX IF NOT EXISTS events_org_idx ON "__SCHEMA__".events (organization_id, execution_id, seq);

ALTER TABLE "__SCHEMA__".records ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".records FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".events ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".events FORCE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__SCHEMA__".audit FORCE ROW LEVEL SECURITY;

-- current_setting(..., true) devolve NULL quando o contexto não foi definido: nenhuma linha passa (falha fechada).
DROP POLICY IF EXISTS org_isolation ON "__SCHEMA__".records;
CREATE POLICY org_isolation ON "__SCHEMA__".records
  USING (organization_id = current_setting('app.organization_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS org_isolation ON "__SCHEMA__".events;
CREATE POLICY org_isolation ON "__SCHEMA__".events
  USING (organization_id = current_setting('app.organization_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS org_isolation ON "__SCHEMA__".audit;
CREATE POLICY org_isolation ON "__SCHEMA__".audit
  USING (organization_id = current_setting('app.organization_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

-- Na carga inicial a API precisa saber quais organizações existem, sem poder ler as linhas delas de uma vez.
-- A função roda com os direitos do dono e devolve só os ids.
CREATE OR REPLACE FUNCTION "__SCHEMA__".list_organization_ids() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT id FROM "__SCHEMA__".records WHERE kind = 'organization' ORDER BY id $$;

REVOKE ALL ON FUNCTION "__SCHEMA__".list_organization_ids() FROM PUBLIC;
