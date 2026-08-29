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
  FOREIGN KEY (organization_id, drawn_by_user_id) REFERENCES memberships (organization_id, user_id)
);

-- One row per sampled application. Separate from the draw so the draw's
-- own facts cannot be edited by adding or removing members, and so a
-- reviewer's independence can be recorded per candidate.
CREATE TABLE IF NOT EXISTS audit_sample_members (
  audit_sample_member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_sample_id uuid NOT NULL REFERENCES audit_samples (audit_sample_id),
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
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
