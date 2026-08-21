# Contracts boundary

This package holds explicit, versionable boundary contracts: runtime-validated (Zod) mirrors of the domain's TypeScript types, so an untrusted payload (provider response, stored record, API body) is rejected rather than silently coerced.

AF-13 added `EvidenceOutcome`: a discriminated union covering every state a criterion's evidence can be in (`supported`, `partially_supported`, `contradicted`, `unclear`, `not_found`, `processing`, `retrying`, `extraction_error`, `citation_invalid`, `invalid_source`, `unsupported_file`, `quarantined`, `failed`). Every schema is `z.strictObject`, so an unrecognized property fails validation, and every record is pinned to `CONTRACT_SCHEMA_VERSION`. Later contract tickets add the remaining candidate/rubric schemas on top of this pattern.

Transport, framework, and provider payloads must be mapped at the boundary and must not leak directly into domain APIs.
