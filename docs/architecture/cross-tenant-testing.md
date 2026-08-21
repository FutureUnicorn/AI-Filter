# Cross-tenant access testing (AF-22)

## Status

AF-22 asked for negative IDOR/RLS tests "on every endpoint and job." No endpoint or job exists yet (AF-15/16/17/19 built the schema, auth, roles, and authorization *mechanism*; AF-5's review workflow and AF-4's evidence pipeline are where real endpoints and jobs are built). This document is the gate this ticket establishes, and `tests/integration/cross-tenant-access.test.ts` is the exhaustive suite against the one real authorization surface that exists today: `authorizeResourceAccess` (AF-19).

## The gate

**Before private beta, every endpoint and background job that reads or writes tenant-owned data must have an explicit negative test proving a cross-tenant attempt is rejected.** This is binding the same way `docs/VALIDATION_STATUS.md`'s gates are: don't mark it passed on "the authorization helper is tested," only on "this specific endpoint has its own IDOR test."

Concretely, for every future endpoint/job ticket:

1. Call the real handler (not just `authorizeResourceAccess` directly) with a caller authenticated as a user who has a membership in some *other* organization, targeting a resource that belongs to an organization they have no membership in.
2. Assert the response is the same `404 not_found` shape a truly nonexistent resource would produce (see `resourceAuthorizationErrorResponse` in `packages/security` -- confirming an organization's existence to an outsider is its own leak, not just unauthorized access).
3. Assert no side effect occurred for a mutating endpoint (no row written, no email sent, no job enqueued) -- rejection must happen before any write, not be a write that gets rolled back.
4. Add the test to this repository's cross-tenant suite (or a colocated one, named so `grep -r "cross-tenant\|IDOR"` finds it), not as a one-off manual check.

## What exists today

`tests/integration/cross-tenant-access.test.ts` exhaustively covers `authorizeResourceAccess`/`resourceAuthorizationErrorResponse` (AF-19): a caller with no membership anywhere, a caller who is `owner` in one organization attempting another (role does not leak across organizations), a caller holding *different* roles in two organizations (each check uses only that organization's own membership row), and both read- and write-shaped capabilities. This is necessary but not sufficient: it proves the *mechanism* is correct in isolation. It does not, and cannot yet, prove any real endpoint calls it correctly, because no real endpoint exists. Re-read the gate above when the first one does.
