-- AF-66: support-access logging.
--
-- "Any time a founder/operator looks at a specific tenant's data for
-- support reasons, it's logged with a reason -- least-privilege, not
-- silent access."
--
-- The load-bearing word is "any". A log that is written on a best-effort
-- basis after the read has already happened does not establish that
-- claim: every time the write failed, the access would be silent, and
-- silent access is precisely what this exists to rule out. So the grant
-- is a row that must exist BEFORE the access, and each access appends
-- its own row. No grant, no access.
--
-- Support access is deliberately NOT a membership. Granting an operator
-- a membership row would work, and it would be wrong in a way that is
-- hard to undo: the operator would then be indistinguishable from a
-- customer's own staff in every capability check, every audit event and
-- every RLS policy in the system. Least privilege means this authority
-- is its own thing, expires on its own, and confers nothing else.

CREATE TABLE IF NOT EXISTS support_access_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  operator_user_id uuid NOT NULL REFERENCES users (user_id),
  -- Why. Mirrors 0018's rule exactly: at least one non-whitespace
  -- character, checked with a character-class predicate rather than
  -- length(trim(...)), because Postgres's trim() strips spaces only and
  -- would accept a reason of tabs and newlines.
  reason text NOT NULL CHECK (reason ~ '[^[:space:]]'),
  -- Who authorised it. Never the operator themselves: an access an
  -- operator can grant to themselves is not a control, and the whole
  -- point of naming a second person is that someone else knew.
  granted_by_user_id uuid NOT NULL REFERENCES users (user_id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT support_access_grants_not_self_granted
    CHECK (operator_user_id <> granted_by_user_id),
  CONSTRAINT support_access_grants_expires_after_grant
    CHECK (expires_at > granted_at),
  -- A bounded window, because an unbounded grant is indistinguishable
  -- from permanent access and nobody ever remembers to revoke. Twenty-
  -- four hours is long enough for a support session that spans a
  -- timezone and short enough that forgetting is not a standing hole.
  -- Renewal is a new row, which means a new reason and a new authoriser.
  CONSTRAINT support_access_grants_bounded_window
    CHECK (expires_at <= granted_at + interval '24 hours'),
  CONSTRAINT support_access_grants_revoked_within_window
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE INDEX IF NOT EXISTS support_access_grants_org_operator_idx
  ON support_access_grants (organization_id, operator_user_id, expires_at DESC);

-- The composite key support_access_events references. Declared here,
-- before the referencing table exists, because a REFERENCES clause needs
-- its target constraint already in place -- adding it afterwards fails
-- with "no unique constraint matching given keys", which is how this
-- migration failed the first time I ran it.
DO $support_access_grants_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.support_access_grants', current_schema())::regclass
       AND conname = 'support_access_grants_id_org_key'
  ) THEN
    ALTER TABLE support_access_grants
      ADD CONSTRAINT support_access_grants_id_org_key UNIQUE (grant_id, organization_id);
  END IF;
END
$support_access_grants_key$;

-- Every individual look, not just the grant. A grant says an operator
-- was allowed to look; only these rows say what they actually opened,
-- which is the difference between "we authorised support access" and
-- "we can tell the customer what was seen".
CREATE TABLE IF NOT EXISTS support_access_events (
  support_access_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES support_access_grants (grant_id),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  operator_user_id uuid NOT NULL REFERENCES users (user_id),
  entity_type text NOT NULL CHECK (entity_type ~ '[^[:space:]]'),
  entity_id text NOT NULL CHECK (entity_id ~ '[^[:space:]]'),
  -- clock_timestamp(), not CURRENT_TIMESTAMP: the latter is transaction
  -- start, so a batch of accesses in one transaction would all claim the
  -- same instant and their order would be unrecoverable. Same lesson as
  -- 0016.
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The grant and the event must agree about which tenant this is. A
  -- composite key rather than two independent references, so an event
  -- cannot cite a grant issued for a different organization.
  FOREIGN KEY (grant_id, organization_id)
    REFERENCES support_access_grants (grant_id, organization_id)
);

CREATE INDEX IF NOT EXISTS support_access_events_org_time_idx
  ON support_access_events (organization_id, accessed_at DESC);

-- Append-only, via 0006's generic function. An access log an operator
-- can edit afterwards answers nothing: the one person with a motive to
-- remove a row is the person the row is about.
DROP TRIGGER IF EXISTS support_access_events_append_only ON support_access_events;
CREATE TRIGGER support_access_events_append_only
  BEFORE UPDATE OR DELETE ON support_access_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS support_access_events_reject_truncate ON support_access_events;
CREATE TRIGGER support_access_events_reject_truncate
  BEFORE TRUNCATE ON support_access_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- Grants are NOT append-only: revocation is an UPDATE, and being able to
-- revoke early is a safety property. But nothing else may change, so the
-- editable surface is exactly one column.
CREATE OR REPLACE FUNCTION reject_support_grant_amendment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support_access_grants is append-only apart from revocation: DELETE is not allowed';
  END IF;
  IF NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.operator_user_id IS DISTINCT FROM OLD.operator_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'support_access_grants: only revoked_at may be updated';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'support_access_grants: revoked_at cannot be changed once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_access_grants_revocation_only ON support_access_grants;
CREATE TRIGGER support_access_grants_revocation_only
  BEFORE UPDATE OR DELETE ON support_access_grants
  FOR EACH ROW EXECUTE FUNCTION reject_support_grant_amendment();

DROP TRIGGER IF EXISTS support_access_grants_reject_truncate ON support_access_grants;
CREATE TRIGGER support_access_grants_reject_truncate
  BEFORE TRUNCATE ON support_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
