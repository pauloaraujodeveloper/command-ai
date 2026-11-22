-- Command AI: armazenamento durável do MVP.
-- __SCHEMA__ é substituído pelo nome do schema (padrão: command_ai).
-- Estas tabelas guardam os registros de negócio como JSONB, sempre com organization_id.
-- O modelo normalizado com RLS por organização (PRD v2, Modelo de dados) substitui isto na etapa 5.

CREATE SCHEMA IF NOT EXISTS "__SCHEMA__";

CREATE TABLE IF NOT EXISTS "__SCHEMA__".records (
  kind            text        NOT NULL,
  id              text        NOT NULL,
  organization_id text,
  data            jsonb       NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS records_org_kind_idx ON "__SCHEMA__".records (organization_id, kind);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".events (
  execution_id text        NOT NULL,
  seq          integer     NOT NULL,
  ts           timestamptz NOT NULL,
  data         jsonb       NOT NULL,
  PRIMARY KEY (execution_id, seq)
);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".audit (
  id              text        PRIMARY KEY,
  organization_id text        NOT NULL,
  at              timestamptz NOT NULL,
  data            jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_org_at_idx ON "__SCHEMA__".audit (organization_id, at);
