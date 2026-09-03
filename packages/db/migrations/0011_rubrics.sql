-- AF-25: rubric draft/edit. One row per rubric version, scoped to a role.
-- Criteria are stored as a JSONB array rather than a normalized child
-- table: a rubric's 5-10 criteria are always read and written together as
-- one ordered unit (never queried or updated individually), which is
-- exactly the case JSONB is a reasonable fit for rather than premature
-- normalization.
--
-- Immutability once published is AF-27's job (a named-approval step and a
-- trigger, matching the append-only pattern from AF-20/AF-40), not this
-- migration's -- this only enforces the shape of a valid row, including
-- that "published" cannot exist without an approval.

CREATE TABLE IF NOT EXISTS rubrics (
  rubric_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES roles (role_id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by_user_id uuid REFERENCES users (user_id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (role_id, version),
  CHECK ((status = 'published') = (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS rubrics_role_id_idx ON rubrics (role_id);

-- At most one draft per role: a second draft would make "the draft" an
-- ambiguous phrase for AF-26's editor to point at. A role can still
-- accumulate many published versions (partial index only covers status
-- = 'draft', so it never conflicts with those).
CREATE UNIQUE INDEX IF NOT EXISTS rubrics_one_draft_per_role_idx
  ON rubrics (role_id) WHERE status = 'draft';
