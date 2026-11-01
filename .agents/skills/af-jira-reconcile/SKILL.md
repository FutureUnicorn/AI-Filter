---
name: af-jira-reconcile
description: Reconcile AI-Filter Jira delivery state with authoritative GitHub, CI, acceptance, and dependency evidence using a read-only-first and human-approved correction workflow.
---

# AF Jira reconciliation

Use this skill for delivery drift audits, stale comments, stacked PR ambiguity, missing dependencies, or proposed historical corrections.

Read `docs/engineering/delivery-workflow.md` (AF-DELIVERY-1.0) and `docs/engineering/jira-reconciliation.md` when that runbook is available.

## Procedure

1. Start read-only. Fetch the current Jira issue, acceptance criteria, comments, status, native links, and dependencies.
2. Find related GitHub PRs and commits. Verify each PR's base, head, merged state, merge revision, review state, and CI evidence. A feature-branch merge is not delivery to `develop`.
3. Evaluate every acceptance criterion and dependency. Distinguish code-complete, deployment-ready, operationally verified, product accepted, and Done.
4. Report ticket, Jira status, PRs, bases, SHAs, CI, acceptance state, blockers, confidence, proposed action, owner, and source URLs.
5. Mark ambiguous or unavailable evidence as `needs attention` or `unknown`; never infer success.
6. Apply a comment or link correction only when specifically authorized. Preserve human notes, update only bot-owned records, and keep Jira transitions human controlled.

## Output

- Evidence-backed drift report
- Proposed comment, link, or status recommendation per ticket
- Confidence and unresolved evidence
- Required human approvals
- Audit record for any authorized write
