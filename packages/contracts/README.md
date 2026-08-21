# Contracts boundary

This package is reserved for explicit, versionable boundary contracts. Runtime validation, unknown-property rejection, state invariants, and the real candidate/rubric/evidence schemas belong to AF-13 and later contract tickets.

Transport, framework, and provider payloads must be mapped at the boundary and must not leak directly into domain APIs.
