-- AF-23: hiring roles (jobs), scoped to an organization. Status starts at
-- draft; later EPIC 3 tickets (rubric approval, AF-27) are what move a
-- role to active. closed is terminal -- enforced at the application
-- layer for now (no rubric/application tables exist yet to check
-- against), same as every other cross-table invariant this schema can't
-- express until those tables land.

CREATE TABLE IF NOT EXISTS roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  created_by_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS roles_organization_id_idx ON roles (organization_id);
