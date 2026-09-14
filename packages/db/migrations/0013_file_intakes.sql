-- AF-28: secure direct file upload. One row per upload attempt, scoped
-- to the role it's for. storage_key is unique and never reused, so two
-- intakes can never collide on the same object even if a filename is
-- reused. Status starts 'pending' (URL minted, nothing uploaded yet) and
-- moves to 'uploaded' exactly once. AF-29 owns quarantine/validation and
-- will extend this table (a new migration, not this one) with the
-- sniffed-mime/size/hash/rejection columns that step needs.

CREATE TABLE IF NOT EXISTS file_intakes (
  intake_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No standalone organizations reference: the composite foreign key
  -- added below points at (role_id, organization_id) on roles, and roles
  -- already has its own organizations FK, so the organization's existence
  -- is guaranteed transitively. A second reference would only add another
  -- constraint blocking the same delete.
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE,
  declared_filename text NOT NULL CHECK (length(declared_filename) > 0),
  declared_mime_type text NOT NULL CHECK (length(declared_mime_type) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'validated', 'quarantined', 'rejected')),
  created_by_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS file_intakes_role_id_idx ON file_intakes (role_id);

-- Cross-tenant misattribution: independent foreign keys to organizations
-- and roles let a row sit in organization B while pointing at
-- organization A's role, because nothing required the two to agree.
-- Verified by inserting one. That misattributed document then counts
-- toward the wrong tenant's per-role figures (AF-58's failed-document
-- rate reads exactly this pair).
--
-- Same defect class as the audit_events actor finding on AF-20, which was
-- fixed with a composite foreign key to memberships, and as
-- evidence_outcomes on AF-48. Third occurrence: the rule is that a table
-- carrying BOTH a tenant column and a reference to a tenant-owned row
-- must constrain the pair, not each column separately.
--
-- ADD CONSTRAINT has no IF NOT EXISTS, and this file replays on every
-- startup, so both statements are guarded. Guarded rather than
-- DROP/ADD: re-adding revalidates every existing row and takes a strong
-- lock, which is the AF-20 replay-cost finding.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roles'::regclass AND conname = 'roles_role_id_organization_id_key'
  ) THEN
    ALTER TABLE roles ADD CONSTRAINT roles_role_id_organization_id_key
      UNIQUE (role_id, organization_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'file_intakes'::regclass AND conname = 'file_intakes_role_organization_fkey'
  ) THEN
    ALTER TABLE file_intakes ADD CONSTRAINT file_intakes_role_organization_fkey
      FOREIGN KEY (role_id, organization_id) REFERENCES roles (role_id, organization_id)
      ON DELETE CASCADE;
  END IF;
END $$;
