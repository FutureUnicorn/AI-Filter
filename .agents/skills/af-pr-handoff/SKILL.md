---
name: af-pr-handoff
description: Prepare an AI-Filter draft pull request and revision-bound Jira ready handoff with per-ticket acceptance, dependency, test, and human ownership evidence.
---

# AF pull request handoff

Use this skill when local implementation is ready for a draft PR or when a push, scope edit, or base change makes prior handoff evidence stale.

Read `docs/engineering/delivery-workflow.md` (AF-DELIVERY-1.0) and use `.github/pull_request_template.md`.

## Procedure

1. Confirm the branch is current enough for review, contains only intended changes, and has no secret or local environment files.
2. Fill the readable PR sections and valid structured metadata for every affected ticket. State user impact, scope exclusions, acceptance state, dependencies by affected stage, exact test evidence, rollout, rollback, limitations, human owner, and AI assistance.
3. Create a draft PR against the intended base. Capture the real PR number, base, and full head SHA.
4. Wait for the actual current-head GitHub checks. Never substitute a local result or an older run.
5. Create or update one tailored Jira Ready for review comment per ticket through an authorized integration. Include the PR, base, current head SHA, current CI, acceptance and dependency state, limitations, and human owner.
6. Verify the trusted handoff check when available. Request independent human review only after evidence is current.

A push or material edit invalidates the earlier ready record. Refresh it. Stacked PRs must name their feature base and cannot claim delivery to `develop`.

## Output

- Draft PR URL, base, and current head SHA
- Current-head check results
- Per-ticket Jira ready comment IDs/URLs or explicit pending state
- Human reviewers requested
- Remaining merge, deployment, and Done blockers
