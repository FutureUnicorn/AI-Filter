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
-- ticket names. The hard ceiling is 180 days, decided in the domain and
-- mirrored by the CHECK below. The ceiling is judged against created_at,
-- so created_at must be the database clock: a caller-writable stamp would
-- let both CHECKs pass while stretching real elapsed life past 180 days
-- from mint (the same root shape as a backdated privacy-request extension
-- or a NaN timestamp that skips a guard). The pin trigger below is what
-- makes the decided ceiling bind to wall time.
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
  -- Attribution columns are uuid only here; membership standing is
  -- enforced by the composite FKs below. An audit-report share link is
  -- an accountability record (AF-90: outward disclosure with no session
  -- behind the view), so the actor must be a member of the organization
  -- the link is minted against -- the same standing rule evidentiary
  -- actor columns use. This is not a claim that every user_id column in
  -- the schema is membership-scoped.
  revoked_by_user_id uuid,
  created_by_user_id uuid NOT NULL,
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
  -- The composite FK proves (role_id, organization_id) is a real pair. It
  -- says nothing about the JSON in report. Without this CHECK a link can
  -- be filed under role A of org X while serving role B's report from
  -- org Y -- a cross-tenant disclosure on an unauthenticated URL, and a
  -- revocation keyed on the link columns would never find it.
  CONSTRAINT audit_report_share_links_report_matches_tenant
    CHECK (
      report->>'organizationId' = organization_id::text
      AND report->>'roleId' = role_id::text
    ),

  -- Tenant scoping through the pair, the shape 0012, 0016, 0019, 0023 and
  -- 0024 use: referencing role_id alone would let one organization mint a
  -- public link for another organization's role.
  FOREIGN KEY (role_id, organization_id)
    REFERENCES roles (role_id, organization_id) ON DELETE CASCADE,
  -- Default MATCH SIMPLE: a NULL revoked_by_user_id (unrevoked link)
  -- satisfies the constraint; only a non-NULL revoker must resolve to a
  -- real membership. created_by_user_id is NOT NULL, so every mint must.
  FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES memberships (organization_id, user_id),
  FOREIGN KEY (organization_id, revoked_by_user_id)
    REFERENCES memberships (organization_id, user_id)
);

-- The lookup an unauthenticated request performs, and the only one it can.
CREATE INDEX IF NOT EXISTS audit_report_share_links_token_idx
  ON audit_report_share_links (token_hash);

CREATE INDEX IF NOT EXISTS audit_report_share_links_role_idx
  ON audit_report_share_links (role_id, created_at DESC);

-- Pin created_at to the database clock on insert, and refuse any later
-- rewrite. DEFAULT CURRENT_TIMESTAMP alone is not enough: an INSERT that
-- names the column bypasses the default, which is how a future-dated
-- stamp would defeat the 180-day ceiling CHECK.
CREATE OR REPLACE FUNCTION pin_audit_report_share_link_created_at() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'audit_report_share_links: created_at is pinned to the database clock and cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_report_share_links_pin_created_at ON audit_report_share_links;
CREATE TRIGGER audit_report_share_links_pin_created_at
  BEFORE INSERT OR UPDATE ON audit_report_share_links
  FOR EACH ROW EXECUTE FUNCTION pin_audit_report_share_link_created_at();

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
