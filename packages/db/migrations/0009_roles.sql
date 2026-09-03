-- AF-23: hiring roles (jobs), scoped to an organization. Status starts at
-- draft; later EPIC 3 tickets (rubric approval, AF-27) are what move a
-- role to active. closed is terminal -- enforced at the application
-- layer for now (no rubric/application tables exist yet to check
-- against), same as every other cross-table invariant this schema can't
-- express until those tables land.

CREATE TABLE IF NOT EXISTS roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  title text NOT NULL CHECK (title ~ '[^[:space:]]'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  created_by_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS roles_organization_id_idx ON roles (organization_id);

-- Postgres trim() strips SPACES ONLY, so `length(trim(x)) > 0` -- and
-- `length(x) > 0` -- accept a value of tabs or newlines. Verified on a
-- real database: length(trim(E'\t\n')) is 2, so E'\t\n' satisfied the
-- old predicate for every column below while being blank to any human
-- reading the record. `~ '[^[:space:]]'` asks the intended question:
-- does this contain at least one non-whitespace character.
--
-- Applied twice: inline above for fresh databases, and as guarded ALTERs
-- here for databases an earlier revision already created, where CREATE
-- TABLE IF NOT EXISTS is a no-op. Guarded rather than DROP/ADD because
-- this file replays on every startup and re-adding a CHECK revalidates
-- every row under a strong lock (the AF-20 replay-cost finding).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roles'::regclass AND conname = 'roles_title_nonblank'
  ) THEN
    ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_title_check;
    ALTER TABLE roles ADD CONSTRAINT roles_title_nonblank CHECK (title ~ '[^[:space:]]');
  END IF;
END $$;
