-- AF-90: unauthenticated share link for the role-level audit report.
--
-- AF-59 built the report and its renderer; the ticket's own words are "in
-- a form an employer can read without a login", and this is that delivery
-- mechanism. The endpoint is unauthenticated by definition, so every
-- decision below is a security decision and none of them is defaulted.
--
-- SCOPE: a frozen snapshot, not a live per-role feed. The report JSON is
-- captured at share time and stored on the link. A per-role link that
-- keeps serving whatever the report says today would disclose data the
-- employer never decided to share -- later candidates, later corrections
-- -- through a URL they approved once, months earlier. Sharing an updated
-- report is a new decision, so it is a new link.
--
-- LIFETIME: always bounded. There is no never-expires option, because a
-- pilot ends and a link outliving the pilot is the failure mode this
-- ticket names. The hard ceiling is enforced here rather than left to the
-- caller.
--
-- REVOCATION: per link, and immediate. Per-link is what answers "I sent
-- it to the wrong person"; revoking every link on a role is what answers
-- "the pilot is over", and the second is a query over the first rather
-- than a separate mechanism.
--
-- ENUMERATION: the raw token is never stored, only its SHA-256 hash, the
-- same rule 0003 applies to magic links -- a leaked database row cannot
-- be used to fetch a report. Entropy is the caller's responsibility and
-- is asserted in the domain layer; OWASP puts the floor for a reference
-- token at 128 bits and this uses 256.
--
-- AUDIT: every view is recorded, because AF-66 established that access to
-- a tenant's data is not silent. What is deliberately NOT recorded is the
-- viewer's IP or user agent: the point is to evidence that the link was
-- used, not to profile whoever opened it, and storing either would put
-- personal data about a non-user into a table the retention plan would
-- then have to account for.

CREATE TABLE IF NOT EXISTS audit_report_share_links (
  share_link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  role_id uuid NOT NULL,
  -- SHA-256 of the raw token, hex. UNIQUE so a hash collision or a
  -- duplicate insert is a constraint error rather than two links racing to
  -- answer for one URL.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- The frozen snapshot. Stored rather than recomputed, so the link keeps
  -- answering with exactly what was shared even after the underlying
  -- evidence changes.
  report jsonb NOT NULL,
  report_generated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES users (user_id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT audit_report_share_links_expiry_is_in_the_future
    CHECK (expires_at > created_at),
  -- Six months. Long enough for any pilot, short enough that a forgotten
  -- link stops working on its own rather than outliving the engagement.
  CONSTRAINT audit_report_share_links_expiry_within_ceiling
    CHECK (expires_at <= created_at + INTERVAL '180 days'),
  -- A revocation names who did it, or it is not a record of anything.
  CONSTRAINT audit_report_share_links_revocation_is_attributed
    CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),

  -- Tenant scoping through the pair, the shape 0012, 0016, 0019, 0023 and
  -- 0024 use: referencing role_id alone would let one organization mint a
  -- public link for another organization's role.
  FOREIGN KEY (role_id, organization_id)
    REFERENCES roles (role_id, organization_id) ON DELETE CASCADE
);

-- The lookup an unauthenticated request performs, and the only one it can.
CREATE INDEX IF NOT EXISTS audit_report_share_links_token_idx
  ON audit_report_share_links (token_hash);

CREATE INDEX IF NOT EXISTS audit_report_share_links_role_idx
  ON audit_report_share_links (role_id, created_at DESC);

-- One row per view. Append-only: a log of who reached an employer's
-- report that the holder of the link can trim is not a log.
CREATE TABLE IF NOT EXISTS audit_report_share_link_views (
  view_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_link_id uuid NOT NULL
    REFERENCES audit_report_share_links (share_link_id) ON DELETE RESTRICT,
  viewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS audit_report_share_link_views_link_idx
  ON audit_report_share_link_views (share_link_id, viewed_at DESC);

DROP TRIGGER IF EXISTS audit_report_share_link_views_append_only ON audit_report_share_link_views;
CREATE TRIGGER audit_report_share_link_views_append_only
  BEFORE UPDATE OR DELETE ON audit_report_share_link_views
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS audit_report_share_link_views_reject_truncate ON audit_report_share_link_views;
CREATE TRIGGER audit_report_share_link_views_reject_truncate
  BEFORE TRUNCATE ON audit_report_share_link_views
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
