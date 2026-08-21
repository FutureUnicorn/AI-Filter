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
-- here that will actually hold.

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users (user_id),
  action text NOT NULL CHECK (
    action IN ('rubric_approved', 'evidence_corrected', 'decision_recorded', 'admin_action')
  ),
  entity_type text NOT NULL CHECK (length(entity_type) > 0),
  entity_id text NOT NULL CHECK (length(entity_id) > 0),
  request_id text NOT NULL CHECK (request_id LIKE 'req\_%' ESCAPE '\'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS audit_events_organization_id_idx ON audit_events (organization_id);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);

CREATE OR REPLACE FUNCTION reject_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
