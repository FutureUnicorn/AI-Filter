---
name: af-implement-and-verify
description: Implement and verify a scoped AI-Filter change after ticket investigation, preserving product, security, architecture, test, and evidence contracts.
---

# AF implementation and verification

Use this skill after `af-investigate-ticket` has produced a current acceptance and dependency map.

Read `docs/engineering/delivery-workflow.md` (AF-DELIVERY-1.0), `docs/PRODUCT_BOUNDARY.md`, `docs/engineering/ci.md`, and applicable scoped instructions.

## Procedure

1. Work from a clean feature branch based on current `origin/develop`. Protect unrelated local work.
2. Trace existing callers, contracts, persistence, external dependencies, tests, and operations for the affected path.
3. Implement the smallest complete change. Preserve AI evidence-only behavior, named-human authority, tenant isolation, audit integrity, and secret handling.
4. Add meaningful tests at the cheapest reliable layer. Cover realistic failures, negative controls, security, and data integrity when relevant. Register every required test in existing repository suites.
5. Run focused validation and the repository gate where the environment supports it. Compare suspected baseline failures against clean current `develop`.
6. Record exact command, result, environment, tested revision, and evidence classification: automated, mocked, live, manual, failed, blocked, or unverified.
7. Review the complete diff for unrelated files, credentials, applicant data, raw provider content, and accidental policy changes.

Do not invent a PR number or final head SHA before a draft PR exists. Do not claim live provider support from mocks or local success from remote CI.

## Output

- Behavior changed and preserved
- Files and contracts affected
- Tests added and failure paths covered
- Exact validation evidence and limitations
- Remaining dependencies and decisions
- Pre-PR readiness checklist
