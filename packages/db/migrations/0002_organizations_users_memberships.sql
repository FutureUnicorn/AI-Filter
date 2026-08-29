-- AF-15: organization, user, and membership schema. Organization is the
-- tenant/policy root; users hold roles via memberships. See
-- docs/PRODUCT_BOUNDARY.md POL-011 (no cross-employer aggregation) --
-- every future query over these tables must stay scoped by organization_id.

CREATE TABLE IF NOT EXISTS organizations (
  organization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  display_name text NOT NULL CHECK (display_name ~ '[^[:space:]]'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per (organization, user): a role change updates this row in
-- place, it never gets a second row. Role is a closed set, not free
-- text, matching AF-13's "explicit state enums" invariant -- an invalid
-- role cannot be inserted, let alone silently authorized against later.
CREATE TABLE IF NOT EXISTS memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'recruiter', 'auditor')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);
-- No separate organization_id index: UNIQUE (organization_id, user_id)
-- already builds one whose leftmost column is organization_id, which
-- serves every lookup a standalone index would. A second one only costs
-- storage and an extra write per membership change. Dropped explicitly
-- because earlier revisions of this file did create it.
DROP INDEX IF EXISTS memberships_organization_id_idx;

-- Replay-safe upgrades for databases created by an earlier revision of this
-- file. CREATE TABLE IF NOT EXISTS above is a no-op once the table exists,
-- so the stronger email constraint has to be applied as an explicit ALTER
-- as well; the migrate service replays every .sql file on each startup, so
-- both statements must tolerate already being applied.
--
-- The previous CHECK only required an '@' after the first character, which
-- accepted 'a@', 'a@@b' and 'a@ b' -- values userSchema's z.email() rejects,
-- so the database was not in fact mirroring the runtime contract it claimed
-- to. This is a closer mirror, not a full RFC 5322 implementation: it
-- requires a non-empty local part, exactly one '@', and a dotted domain with
-- no whitespace anywhere.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_check;
ALTER TABLE users ADD CONSTRAINT users_email_check
  CHECK (email = lower(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$');

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
    WHERE conrelid = 'users'::regclass AND conname = 'users_display_name_nonblank'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_check;
    ALTER TABLE users ADD CONSTRAINT users_display_name_nonblank CHECK (display_name ~ '[^[:space:]]');
  END IF;
END $$;
