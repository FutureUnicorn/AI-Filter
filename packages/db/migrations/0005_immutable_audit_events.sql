-- AF-20: append-only audit log for every consequential action (rubric
-- approval, evidence correction, human decision, admin action). Every
-- one of these is required by docs/PRODUCT_BOUNDARY.md POL-001 to be
-- attributable to a named human, so actor_user_id is NOT NULL, never a
-- "system" placeholder.
--
-- Immutability is enforced by a trigger, not by REVOKE-ing UPDATE/DELETE
-- privileges: triggers fire regardless of the connecting role, including
-- a superuser, whereas privilege grants (like row-level security, see
-- docs/architecture/tenant-isolation.md) do not apply to superusers.
-- AF-11's app role is a superuser, so a trigger is the only enforcement
-- here that will actually hold. TRUNCATE bypasses row-level UPDATE/DELETE
-- triggers, so a separate statement-level trigger rejects it too.
--
-- CREATE TRIGGER is not idempotent; the migrate service replays every
-- .sql file on each local up, so drop-then-create keeps this replay-safe.

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users (user_id),
  action text NOT NULL CHECK (
    action IN ('rubric_approved', 'evidence_corrected', 'decision_recorded', 'admin_action')
  ),
  entity_type text NOT NULL CHECK (length(entity_type) > 0),
  entity_id text NOT NULL CHECK (length(entity_id) > 0),
  request_id text NOT NULL,
  -- clock_timestamp(), not CURRENT_TIMESTAMP: the latter is the
  -- TRANSACTION start time. appendAuditEvent deliberately supports a
  -- caller-owned client so an action and its audit row commit together,
  -- and that transaction is usually opened before the consequential
  -- write, so CURRENT_TIMESTAMP would record a time that can
  -- substantially predate the action and misorder the audit trail.
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS audit_events_organization_id_idx ON audit_events (organization_id);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Same format as contracts' requestIdSchema (req_ + version-4 UUID).
--
-- Added only when absent, rather than dropped and re-added. The migrate
-- service replays every .sql file on each startup, and ADD CONSTRAINT
-- ... CHECK takes an ACCESS EXCLUSIVE lock and revalidates every existing
-- row. On an append-only audit table that cost grows without bound, so an
-- unconditional drop/add turns each routine deployment into a full scan
-- that blocks writers for as long as it runs.
--
-- If this predicate ever needs to change, add a new migration; editing it
-- here would leave existing databases on the old constraint silently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_events'::regclass
      AND conname = 'audit_events_request_id_check'
  ) THEN
    ALTER TABLE audit_events ADD CONSTRAINT audit_events_request_id_check CHECK (
      request_id ~ '^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );
  END IF;
END $$;

-- Actor must belong to the audited organization, not merely exist as a
-- user. That rule is enforced by the BEFORE INSERT trigger created in
-- 0006, NOT by a standing foreign key.
--
-- A standing FK cannot live here. The migrate service replays every
-- .sql file in order on each startup under `psql -v ON_ERROR_STOP=1`
-- (see infra/compose/runtime.yml), so re-adding the constraint would
-- validate it against audit rows whose actor has since been legitimately
-- offboarded -- 0006 exists precisely to allow that. The ADD would fail
-- and abort startup before 0006 could drop the constraint again, leaving
-- the environment permanently unable to migrate. The DROP below stays so
-- replaying 0005 over an older database still clears the obsolete
-- constraint.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_membership_fkey;

CREATE OR REPLACE FUNCTION reject_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

DROP TRIGGER IF EXISTS audit_events_reject_truncate ON audit_events;
CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation();
