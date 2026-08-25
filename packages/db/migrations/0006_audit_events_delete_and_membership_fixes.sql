-- AF-20 follow-up: two real bugs flagged against 0005_immutable_audit_events.sql.
--
-- 1. organization_id's ON DELETE CASCADE fought the append-only trigger:
--    deleting an organization with any audit history always failed, since
--    the CASCADE delete attempt on audit_events hit the reject-mutation
--    trigger. Switched to the implicit RESTRICT default (no ON DELETE
--    clause at all) so the real reason a delete fails is surfaced
--    directly, not masked behind an unrelated cascade attempt.
--
-- 2. audit_events_actor_membership_fkey was a standing FK to memberships,
--    which permanently blocks deleting/offboarding a membership once that
--    person has any audit history at all -- the FK can never be
--    satisfied-away. Replaced with a BEFORE INSERT trigger that validates
--    the membership existed at the moment this audit event was recorded,
--    without holding a permanent referential constraint against future
--    membership deletion.

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_organization_id_fkey;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations (organization_id);

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_membership_fkey;

CREATE OR REPLACE FUNCTION reject_audit_event_without_membership() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
     WHERE organization_id = NEW.organization_id
       AND user_id = NEW.actor_user_id
  ) THEN
    RAISE EXCEPTION 'audit_events.actor_user_id must be a member of audit_events.organization_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_require_membership ON audit_events;
CREATE TRIGGER audit_events_require_membership
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_without_membership();
