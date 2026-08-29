-- AF-16: invite-only magic-link authentication. There is no public
-- self-service signup, so a token either (a) proves an existing user's
-- email for a plain login, or (b) is an invite that grants a specific
-- role in a specific organization on redemption. The raw token is never
-- stored, only its SHA-256 hash: a leaked database row cannot be used to
-- sign in.

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  organization_id uuid REFERENCES organizations (organization_id) ON DELETE CASCADE,
  role text CHECK (role IN ('owner', 'admin', 'recruiter', 'auditor')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- An invite carries both organization_id and role, or neither (a plain
  -- login-link token for an existing user). One without the other is not
  -- a valid state and must be structurally rejected, not just discouraged.
  CHECK ((organization_id IS NULL) = (role IS NULL))
);

CREATE INDEX IF NOT EXISTS magic_link_tokens_email_idx ON magic_link_tokens (email);
