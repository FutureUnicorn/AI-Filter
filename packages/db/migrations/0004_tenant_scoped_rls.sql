-- AF-18: tenant-scoped row-level security, narrowly scoped. See
-- docs/architecture/tenant-isolation.md for the reassessment behind
-- this scope: full multi-tenant RLS is deferred until there is a real
-- shared multi-tenant database (AF-11 already isolates every pilot into
-- its own database today). This migration enables RLS on the one table
-- that is unambiguously tenant-owned right now.
--
-- No application code sets app.current_org_id yet, so this policy is
-- fail-closed and inert: current_setting(..., true) returns NULL when
-- unset, and organization_id = NULL is never true, so every connection
-- that doesn't set it sees zero rows rather than every row.
--
-- Known gap (see docs/architecture/tenant-isolation.md): AF-11's
-- POSTGRES_USER is the official postgres image's bootstrap role, which
-- is a superuser, and superusers always bypass RLS regardless of FORCE.
-- This policy is verified correct against a genuine non-superuser role
-- but is currently a no-op against the app's actual database role.

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_tenant_isolation ON memberships
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
