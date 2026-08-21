# Contracts boundary

This package holds explicit, versionable boundary contracts: runtime-validated (Zod) mirrors of the domain's TypeScript types, so an untrusted payload (provider response, stored record, API body) is rejected rather than silently coerced.

AF-13 added `EvidenceOutcome`: a discriminated union covering every state a criterion's evidence can be in (`supported`, `partially_supported`, `contradicted`, `unclear`, `not_found`, `processing`, `retrying`, `extraction_error`, `citation_invalid`, `invalid_source`, `unsupported_file`, `quarantined`, `failed`). Every schema is `z.strictObject`, so an unrecognized property fails validation, and every record is pinned to `CONTRACT_SCHEMA_VERSION`. Later contract tickets add the remaining candidate/rubric schemas on top of this pattern.

AF-14 added the API-surface conventions every future endpoint adopts: `generateRequestId`/`requestIdSchema`/`withRequestId` (every response carries an `X-Request-Id`), `buildApiError`/`apiErrorBodySchema` (one strict, versioned error shape for the whole API), and `checkIdempotencyRequirement`/`idempotencyErrorResponse` (mutating methods — `POST`/`PUT`/`PATCH`/`DELETE` — require an `Idempotency-Key`; missing and invalid are distinct, non-collapsing outcomes, not one status string). These are pure functions over plain strings, so both `apps/web` and `apps/worker` can adopt them without depending on either's HTTP framework. No existing endpoint was changed by this ticket.

AF-15 added `organizationSchema`/`userSchema`/`membershipSchema`, the runtime mirrors of `packages/db/migrations/0002_organizations_users_memberships.sql`. `MembershipRole` (`owner`/`admin`/`recruiter`/`auditor`) is a closed set enforced at three layers: the TypeScript union, the Zod `z.enum`, and a Postgres `CHECK` constraint, so an invalid role can't reach the database however it got constructed. Organization is the tenant/policy root; every future query over these tables must stay scoped by `organizationId` (docs/PRODUCT_BOUNDARY.md POL-011).

Transport, framework, and provider payloads must be mapped at the boundary and must not leak directly into domain APIs.
