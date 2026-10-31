# Jira delivery evidence and reconciliation

**Policy:** AF-DELIVERY-1.0

This slice records verified merge evidence and detects GitHub-Jira drift. It never transitions Jira, approves scope, or treats a merge as product acceptance.

## Delivery evidence state

| State | Authoritative evidence | Automated action |
|---|---|---|
| Investigated | Jira issue, acceptance criteria, comments, links, and a human-owned start handoff | Project skill or authorized integration; this workflow does not infer it |
| Draft | Draft PR metadata tied to its current head | Report-only structural validation |
| Ready for review | Current PR head, successful PR `CI / Required`, authorized ready marker, Jira issues and native links | `Jira Handoff / Ready` check |
| Merged to delivery base | Direct merge to `develop` or `main`, exact successful target-branch `CI / Required`, prior authorized ready marker | One bot-owned merged comment per ticket, stage, and PR |
| Reconciled | Merge, target CI, Jira issue, and exact bot marker agree | Read-only report records `verified` |
| Needs attention | Missing, stale, duplicate, unavailable, or invalid evidence | Read-only correction proposal with sources; no mutation |

A feature branch merge does not enter the merged-to-delivery-base state. The post-merge workflow accepts only `develop` and `main`.

## Post-merge workflow

`.github/workflows/jira-post-merge.yml` listens for completion of the existing `CI` workflow. It proceeds only for a successful push run on `develop` or `main`, then re-fetches:

- workflow name, path, event, branch, full merge SHA, conclusion, and `CI / Required` job;
- the single PR directly associated with that merge commit;
- the PR's target base, head SHA, merge SHA, merged state, and structured metadata;
- every declared AF issue, native dependency link, referenced issue status, and authorized ready comment.

The workflow upserts a marker of this form:

```text
[AF-DELIVERY v1 stage=merged repo=FutureUnicorn/AI-Filter pr=<number> head=<pr-head> merge=<merge-sha> base=<develop-or-main>]
```

Retries update only the service account's own comment for the same issue, stage, and PR. A copied human marker is ignored. Duplicate bot comments stop for human cleanup. Concurrency is serialized per merge SHA and active runs are not cancelled.

The comment contains validated identifiers, status counts, dependency stages, exact GitHub links, and a human-readable recommendation. It does not reproduce arbitrary PR evidence text, prompts, provider responses, candidate data, or secrets.

A Done recommendation appears only when that ticket reports every criterion as Met, no test is classified unverified, and no unresolved deployment or Done-stage limitation remains. A human still evaluates product and operational acceptance. The workflow never calls a Jira transition endpoint.

## Ongoing reconciliation

`.github/workflows/jira-reconciliation.yml` runs daily and on manual dispatch. It scans direct merges to `develop` and `main` for a bounded 1 to 90-day window and creates Markdown and JSON artifacts. It classifies each ticket and PR as:

- `verified`
- `verified-with-limitations`
- `dependency-drift`
- `invalid-metadata`
- `missing-target-ci`
- `missing-merge-evidence`
- `stale-merge-evidence`
- `duplicate-merge-evidence`
- `unknown-jira`

`unknown-jira` is used when external evidence cannot be read. An outage never becomes success or proven drift. Proposals name a scoped replay, investigation, or human cleanup; the reconciliation script contains no Jira write or transition method.

## Administrative activation

1. Merge and promote the reviewed workflows and scripts to the default branch, currently `main`.
2. Configure the Jira service credentials described in `docs/engineering/trusted-jira-handoff.md`.
3. Pilot ready comment creation, ready verification, merge to `develop`, target-branch CI, merged comment creation, replay, and duplicate handling on a dedicated AF issue.
4. Confirm the scheduled report artifact contains only ticket keys, PR numbers, GitHub/Jira evidence URLs, revisions, classifications, and proposals.
5. Configure the schedule owner and retention expectations.
6. Keep Jira status transitions disabled. Any later transition workflow needs a separate policy, human override, audit, and approval design.

## Local verification

```bash
node --test scripts/ci/tests/jira-post-merge.test.mjs
node --test scripts/ci/tests/jira-reconciliation.test.mjs
node --test tests/architecture/jira-reconciliation-workflow.test.ts
```
