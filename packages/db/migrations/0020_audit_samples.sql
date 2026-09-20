-- AF-52: low-evidence random audit sampling.
--
-- "Randomly sample low-ranked/low-evidence candidates for independent
-- review -- this is how false negatives get caught, not by trusting the
-- model's confidence."
--
-- The table exists for one reason: a sample that can be silently
-- re-rolled is worse than no sample at all. It carries the authority of
-- a random check while being a chosen one, and nothing downstream can
-- tell the difference. Recording the seed and the result, append-only,
-- makes the selection reproducible by anyone and re-rollable by no one.
--
-- Note what is NOT here: no score, no rank, no confidence. There is
-- nothing in this system to sort candidates by -- POL-003 forbids a
-- scoring field, AF-46 fixes queue order to the employer's file and
-- AF-47's filters are a subsequence of it. The "low-ranked" half of the
-- ticket asks for something the product deliberately does not have; the
-- selectable population is defined by evidence kind instead.

CREATE TABLE IF NOT EXISTS audit_samples (
  audit_sample_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  -- The input that makes the draw reproducible. Non-blank for the same
  -- reason a correction reason is (0018): an empty seed is a seed that
  -- explains nothing.
  seed text NOT NULL CHECK (seed ~ '[^[:space:]]'),
  requested_size integer NOT NULL CHECK (requested_size > 0),
  -- How many applications were eligible when the draw was made. Without
  -- it a later reader cannot tell a sample of 3 from 4 candidates from
  -- one of 3 from 4000, which is the difference between a check and a
  -- gesture.
  eligible_count integer NOT NULL CHECK (eligible_count >= 0),
  drawn_by_user_id uuid NOT NULL,
  drawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (role_id, organization_id) REFERENCES roles (role_id, organization_id),
  FOREIGN KEY (organization_id, drawn_by_user_id) REFERENCES memberships (organization_id, user_id),
  -- Redundant against the primary key, and that is the point: it gives
  -- audit_sample_members a composite target so a member row cannot name
  -- one organization while its draw belongs to another. Same pattern as
  -- the roles and applications references above.
  UNIQUE (audit_sample_id, organization_id)
);

-- One row per sampled application. Separate from the draw so the draw's
-- own facts cannot be edited by adding or removing members, and so a
-- reviewer's independence can be recorded per candidate.
CREATE TABLE IF NOT EXISTS audit_sample_members (
  audit_sample_member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_sample_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  -- Review: this reference used to be single-column, so a member could
  -- carry organization B while its draw carried organization A, and the
  -- row was accepted. Verified by executing the insert. It matters more
  -- here than in the usual instance of this class because sampledCount
  -- is published: AF-59 renders it into a document meant to be read
  -- without a login, and the same report promises the draw can be
  -- reproduced from the seed. A foreign member is not in the role's
  -- eligible set, so the recomputed sample and the stored one diverge
  -- and that promise becomes false.
  FOREIGN KEY (audit_sample_id, organization_id) REFERENCES audit_samples (audit_sample_id, organization_id),
  FOREIGN KEY (application_id, organization_id) REFERENCES applications (application_id, organization_id),
  -- A candidate appears at most once in a given draw.
  UNIQUE (audit_sample_id, application_id)
);

CREATE INDEX IF NOT EXISTS audit_samples_role_idx ON audit_samples (role_id, drawn_at DESC);
CREATE INDEX IF NOT EXISTS audit_sample_members_sample_idx ON audit_sample_members (audit_sample_id);

-- Append-only, both tables. A draw whose membership can be edited after
-- the fact is a draw that proves nothing.
DROP TRIGGER IF EXISTS audit_samples_append_only ON audit_samples;
CREATE TRIGGER audit_samples_append_only
  BEFORE UPDATE OR DELETE ON audit_samples
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS audit_samples_reject_truncate ON audit_samples;
CREATE TRIGGER audit_samples_reject_truncate
  BEFORE TRUNCATE ON audit_samples
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS audit_sample_members_append_only ON audit_sample_members;
CREATE TRIGGER audit_sample_members_append_only
  BEFORE UPDATE OR DELETE ON audit_sample_members
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS audit_sample_members_reject_truncate ON audit_sample_members;
CREATE TRIGGER audit_sample_members_reject_truncate
  BEFORE TRUNCATE ON audit_sample_members
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- Review REV-003: the append-only triggers above stop a draw being
-- edited or deleted, and stop nothing being ADDED to it. A committed
-- draw could be extended by a later INSERT, and the writer would accept
-- any member list at all: a draw claiming requested_size 2 over an
-- eligible population of 3 could commit with zero members, or with
-- three.
--
-- Either shape makes the record lie in the direction that matters.
-- "We sampled and found nobody" and "we sampled everybody" are both
-- reachable without the seed having decided anything, which is exactly
-- what recording the seed exists to rule out.
--
-- So the count is an invariant of the draw rather than a property of
-- whoever wrote it. DEFERRABLE INITIALLY DEFERRED because the draw and
-- its members are inserted in one transaction and the row count is only
-- correct once that transaction is complete: a constraint checked per
-- statement would reject the first member of a two-member draw.
--
-- Attached to BOTH tables on purpose. A draw over an empty eligible
-- population legitimately has zero members, so nothing is ever inserted
-- into audit_sample_members and a trigger living only there would never
-- fire to check it.
CREATE OR REPLACE FUNCTION assert_audit_sample_is_exactly_drawn() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected integer;
  actual integer;
BEGIN
  -- Qualified with TG_TABLE_SCHEMA rather than written bare. These
  -- migrations are applied into whichever schema the caller selected,
  -- and the trigger fires on connections that never set that
  -- search_path: the application's own pool resolves to public, so an
  -- unqualified audit_samples here fails with "relation does not exist"
  -- at COMMIT, turning the guarantee into an outage.
  EXECUTE format(
    'SELECT LEAST(s.requested_size, s.eligible_count) FROM %I.audit_samples s WHERE s.audit_sample_id = $1',
    TG_TABLE_SCHEMA
  ) INTO expected USING NEW.audit_sample_id;

  IF expected IS NULL THEN
    -- The draw itself is gone, so there is nothing to be consistent with.
    RETURN NULL;
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM %I.audit_sample_members m WHERE m.audit_sample_id = $1',
    TG_TABLE_SCHEMA
  ) INTO actual USING NEW.audit_sample_id;

  IF actual <> expected THEN
    RAISE EXCEPTION
      'audit sample % must record exactly % member(s) (least of requested_size and eligible_count), found %',
      NEW.audit_sample_id, expected, actual
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_samples_exact_membership ON audit_samples;
CREATE CONSTRAINT TRIGGER audit_samples_exact_membership
  AFTER INSERT ON audit_samples
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_audit_sample_is_exactly_drawn();

DROP TRIGGER IF EXISTS audit_sample_members_exact_membership ON audit_sample_members;
CREATE CONSTRAINT TRIGGER audit_sample_members_exact_membership
  AFTER INSERT ON audit_sample_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_audit_sample_is_exactly_drawn();
