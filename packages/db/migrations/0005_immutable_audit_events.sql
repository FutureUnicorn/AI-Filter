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
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS audit_events_organization_id_idx ON audit_events (organization_id);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Same format as contracts' requestIdSchema (req_ + version-4 UUID).
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_request_id_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_request_id_check CHECK (
  request_id ~ '^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
);

-- Actor must belong to the audited organization, not merely exist as a user.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_membership_fkey;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_membership_fkey
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES memberships (organization_id, user_id);

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
