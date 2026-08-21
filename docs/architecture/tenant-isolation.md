# Tenant isolation (AF-18)

## Status

AF-18 asked for tenant-scoped row-level security (RLS), with an explicit instruction to reassess against a single-tenant-per-pilot alternative before over-building pre-revenue. This document is that reassessment and the resulting decision. It is binding until superseded by a later ticket, the same way `docs/PRODUCT_BOUNDARY.md`'s validation-stage gates are.

## The reassessment

Full multi-tenant RLS defends against one specific failure: a bug in application code that queries a shared table without an `organization_id` filter, leaking rows across organizations that live in the *same* database.

That failure mode does not exist yet, because it isn't the current deployment shape:

- AF-11 already gives every pilot its own isolated database, schema, storage bucket, and credentials (PR/SHA-scoped preview environments; separate staging; a production-shaped environment with no customer data). There is no shared database with two organizations' rows in it today.
- There are zero paying customers (`docs/VALIDATION_STATUS.md`: all gates "Not started"). AF-8 (customer validation) runs in parallel with engineering, but no pilot has started.
- No CRUD endpoint exists yet for organizations, users, or memberships (AF-15 is schema only; AF-16 is auth only). The rows RLS would protect aren't reachable through the API surface today.

Building full RLS now means designing and maintaining per-request Postgres session-variable wiring (`SET app.current_org_id`), extending `packages/db`'s current one-off-`Client`-per-call pattern into real connection/session management, and getting cross-table policies right for tables that aren't simple `organization_id`-keyed rows (`organizations` itself, and `users`, who can belong to more than one organization) -- all before there is a second paying customer to actually protect from a third one.

## Decision

Defer full multi-tenant RLS (session-variable-driven policies across every tenant-owned table, wired through a real per-request database session) until there is a real shared multi-tenant database, i.e. more than one paying pilot's data living in the same deployed database at once. Revisit this document when that happens, or when AF-19 (server-side resource authorization) or a connection-pooling ticket needs to make the same call.

Until then, defense in depth is:

1. **Primary**: AF-19's server-side resource authorization -- every request's membership is checked against `roleHasCapability` (AF-17) and the resource's `organization_id` before any query runs.
2. **Infrastructure**: AF-11's per-pilot database isolation is the real tenant boundary today, not a row-level policy inside one database.
3. **Narrow, real RLS today**: `memberships` is the one table in the current schema that is unambiguously tenant-owned (a single `organization_id` on every row, `NOT NULL`). This migration enables RLS on it now, fail-closed, verified directly against Postgres -- see below. `organizations` and `users` are not simple `organization_id`-keyed rows (an organization's own id is not a foreign key into itself; a user can hold memberships in more than one organization) and are out of scope for row-level policies until there's a real per-request session identity to write correct policies against. `magic_link_tokens.organization_id` is nullable (a plain login token has none), so it isn't RLS-shaped either; it stays covered by API-level authorization only.

## What "narrow, real RLS today" means

`packages/db/migrations/0004_tenant_scoped_rls.sql` enables `ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on `memberships`, with a policy keyed on the Postgres session setting `app.current_org_id`:

```sql
USING (organization_id = current_setting('app.current_org_id', true)::uuid)
```

`current_setting(..., true)` returns `NULL` when the setting was never made, and `organization_id = NULL` is never true, so a connection that never sets `app.current_org_id` sees zero rows -- fail closed, not fail open. No application code sets this setting yet; that wiring is for whichever ticket builds the first real per-request database session (AF-19 or later).

## Known gap: this policy does not apply to the current app database role

Verified directly against Postgres 17.10: as a genuine non-superuser role, the policy behaves exactly as designed (0 rows with no session context, org-scoped visibility once `app.current_org_id` is set, cross-tenant `INSERT` rejected by `WITH CHECK`).

But **`POSTGRES_USER` in the official `postgres` Docker image (the one AF-11's infra runs) is created with superuser privileges** ([Docker Hub: "This variable will create the specified user with superuser power"](https://hub.docker.com/_/postgres)), and Postgres superusers unconditionally bypass row-level security, `FORCE ROW LEVEL SECURITY` included -- there is no configuration flag that changes this. AF-11's `web`/`worker`/`migrate` containers all connect as this same bootstrap superuser today (`infra/compose/runtime.yml`). That means this policy is currently a correct no-op: it will not block anything until the application connects as a distinct, non-superuser Postgres role.

This is a real, separate finding, not a reason to abandon the policy: it costs nothing to have in place now, and it is already correct for the day a non-superuser app role exists. Creating that role is an infrastructure change to AF-11's Postgres bootstrapping, out of this ticket's scope (and not this repo's to change unilaterally without the person who owns that infrastructure). Flagging it here so it isn't mistaken for real protection in the meantime.
