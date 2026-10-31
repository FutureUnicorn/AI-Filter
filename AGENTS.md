# AI-Filter repository instructions - AF-DELIVERY-1.0

Before changing code or preparing a pull request, read and follow:

1. `docs/engineering/delivery-workflow.md` - the canonical delivery policy.
2. `docs/PRODUCT_BOUNDARY.md` - binding product behavior and safety constraints.
3. `docs/engineering/ci.md` - required validation and release gates.
4. The complete Jira issue, acceptance criteria, comments, and native dependency links.
5. Every applicable scoped `AGENTS.md`. Changes under `apps/web` also require `apps/web/AGENTS.md`.

Use the latest `origin/develop` as the comparison baseline. Before coding, produce an acceptance-criterion-to-code-and-test map, identify dependencies and unresolved decisions, and create an evidence-backed Jira start handoff through an authorized integration. If Jira access is unavailable, report that limitation and never claim the handoff occurred.

Before requesting review, run applicable validation, distinguish automated, mocked, live, manual, failed, blocked, and unverified evidence, and use the repository pull request template. After the draft pull request exists, refresh Jira ready evidence with the real pull request number, target base, and current full head SHA. Refresh that evidence after every material push or review fix.

A merge into a feature branch is not delivery to `develop`. A merge alone does not prove that acceptance criteria, operational dependencies, or deployment requirements are complete. Jira transitions remain human controlled unless a separately reviewed protected transition is enabled.

AI assistance does not replace human evidence ownership, review, or approval. Never invent Jira updates, dependency links, test results, CI status, approvals, live verification, or deployment evidence.
