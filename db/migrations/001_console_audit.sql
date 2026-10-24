-- Audit trail of the operations console (src/console). One row per action
-- attempt: replays and discards of dead-lettered events, and alert silences,
-- including attempts that were refused or not authorised.
--
-- Applied by db/migrate.sh, which runs every file in this directory in name
-- order on each `docker compose up`. Every statement here can run again.

CREATE TABLE IF NOT EXISTS console_audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Database clock, like car_positions.updated_at.
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Ties the "started" row of an action to the row with its outcome.
  request_id uuid NOT NULL,
  -- The operator the token belongs to; null when no valid token was sent.
  operator   text,
  client     text NOT NULL,
  action     text NOT NULL CHECK (action IN ('replay', 'discard', 'silence')),
  target     text NOT NULL,
  reason     text,
  result     text NOT NULL CHECK (result IN (
               'started', 'ok', 'refused', 'not_found', 'failed',
               'unauthorized', 'invalid', 'rate_limited')),
  detail     jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS console_audit_at_idx ON console_audit (at);

-- Rows can be added and read, never changed or removed. The trigger applies
-- to every role, including the table owner.
CREATE OR REPLACE FUNCTION console_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'console_audit is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS console_audit_no_change ON console_audit;
CREATE TRIGGER console_audit_no_change
  BEFORE UPDATE OR DELETE ON console_audit
  FOR EACH ROW EXECUTE FUNCTION console_audit_append_only();

DROP TRIGGER IF EXISTS console_audit_no_truncate ON console_audit;
CREATE TRIGGER console_audit_no_truncate
  BEFORE TRUNCATE ON console_audit
  FOR EACH STATEMENT EXECUTE FUNCTION console_audit_append_only();

-- The console logs in as its own role, which may only add audit rows. It
-- cannot read or change car_positions either. Its password comes from the
-- environment (CONSOLE_DB_PASSWORD).
SELECT format('CREATE ROLE railcar_console LOGIN PASSWORD %L', :'console_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'railcar_console')
\gexec
SELECT format('ALTER ROLE railcar_console PASSWORD %L', :'console_password')
\gexec

REVOKE ALL ON console_audit FROM PUBLIC;
REVOKE ALL ON console_audit FROM railcar_console;
GRANT INSERT ON console_audit TO railcar_console;
