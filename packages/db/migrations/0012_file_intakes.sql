-- AF-28: secure direct file upload. One row per upload attempt, scoped
-- to the role it's for. storage_key is unique and never reused, so two
-- intakes can never collide on the same object even if a filename is
-- reused. Status starts 'pending' (URL minted, nothing uploaded yet) and
-- moves to 'uploaded' exactly once. AF-29 owns quarantine/validation and
-- will extend this table (a new migration, not this one) with the
-- sniffed-mime/size/hash/rejection columns that step needs.

CREATE TABLE IF NOT EXISTS file_intakes (
  intake_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (role_id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  declared_filename text NOT NULL CHECK (length(declared_filename) > 0),
  declared_mime_type text NOT NULL CHECK (length(declared_mime_type) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'validated', 'quarantined', 'rejected')),
  created_by_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS file_intakes_role_id_idx ON file_intakes (role_id);
