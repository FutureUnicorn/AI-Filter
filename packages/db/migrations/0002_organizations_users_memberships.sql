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
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  display_name text NOT NULL CHECK (length(display_name) > 0),
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
CREATE INDEX IF NOT EXISTS memberships_organization_id_idx ON memberships (organization_id);
