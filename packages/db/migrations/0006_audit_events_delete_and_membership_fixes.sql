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

-- Converted only while it is still the CASCADE version, then left alone.
-- This file replays on every startup, and ADD CONSTRAINT ... FOREIGN KEY
-- takes a strong lock and validates every existing row; on an append-only
-- audit table an unconditional drop/add makes deployment cost grow with
-- the audit history. confdeltype = 'c' is ON DELETE CASCADE, so the first
-- replay converts and every later one is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_events'::regclass
      AND conname = 'audit_events_organization_id_fkey'
      AND confdeltype = 'c'
  ) THEN
    ALTER TABLE audit_events DROP CONSTRAINT audit_events_organization_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_events'::regclass
      AND conname = 'audit_events_organization_id_fkey'
  ) THEN
    ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations (organization_id);
  END IF;
END $$;

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_membership_fkey;

-- The function is pinned to the schema it is installed into, captured at
-- migration time via current_schema(). Without that pin the unqualified
-- `memberships` reference resolves against whatever search_path the
-- CALLER happens to have. That breaks for real: migrations run with
-- PGOPTIONS="-c search_path=$DATABASE_SCHEMA" (infra/compose/runtime.yml),
-- but the application connects with no search_path at all and fully
-- qualifies its own table names instead (packages/db). So in any
-- environment where DATABASE_SCHEMA is not `public` -- every preview
-- environment, per scripts/environment/model.mjs -- PL/pgSQL would fall
-- back to `$user, public` and every audit insert would fail with
-- `relation "memberships" does not exist`.
--
-- Built through format()/EXECUTE because the schema name is only known
-- at apply time; %I quotes it as an identifier. pg_temp is pinned last,
-- which is the standard guard against search_path capture.
DO $migration$
BEGIN
  EXECUTE format(
    $definition$
      CREATE OR REPLACE FUNCTION reject_audit_event_without_membership() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = %I, pg_temp
      AS $body$
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
      $body$;
    $definition$,
    current_schema()
  );
END
$migration$;

DROP TRIGGER IF EXISTS audit_events_require_membership ON audit_events;
CREATE TRIGGER audit_events_require_membership
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_without_membership();
