---
name: af-investigate-ticket
description: Investigate an AI-Filter Jira issue before implementation by reconciling current Jira, GitHub, repository, acceptance criteria, and dependency evidence.
---

# AF ticket investigation

Use this skill when starting or resuming an AF issue, when scope may have changed, or when a ticket's Jira state may disagree with the repository.

Read `docs/engineering/delivery-workflow.md` (AF-DELIVERY-1.0), `docs/PRODUCT_BOUNDARY.md`, `docs/engineering/ci.md`, and applicable scoped instructions.

## Procedure

1. Fetch the complete Jira issue, acceptance criteria, comments, subtasks, native links, and referenced decisions through an authorized integration.
2. Fetch current `origin/develop`. Inspect related merged, open, closed, and stacked PRs and their real target branches.
3. Locate existing code, tests, migrations, configuration, infrastructure, and documentation for every criterion.
4. Produce an acceptance matrix with criterion, current behavior, intended change, code location, test/evidence, status, and remaining decision.
5. Produce a dependency matrix with relationship, source, current status, affected stage, effect, owner, next action, and native link state.
6. Identify concrete product, privacy, authorization, tenant, data, CI, deployment, and operational risks.
7. Create or update a readable Jira Started comment when authorized. Include baseline SHA, scope, acceptance plan, dependencies, risks, human owner, and next verification.

## Stop conditions

- Jira is unavailable and the task requires a completed Jira handoff.
- Acceptance criteria conflict with `docs/PRODUCT_BOUNDARY.md` or another binding control.
- A blocking decision could materially change security, data, product behavior, or architecture.

Record the blocker and owner. Never invent approval, Jira state, PR delivery, or a dependency relationship.

## Output

- Current baseline and target branch
- Acceptance matrix
- Dependency matrix
- Risks and decisions
- Jira comment ID or an explicit handoff limitation
- Recommended next engineering step
