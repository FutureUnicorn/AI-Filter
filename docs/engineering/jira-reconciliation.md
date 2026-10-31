# GitHub-Jira reconciliation and historical drift audit

Policy version: `AF-DELIVERY-1.0`
Snapshot: 2026-10-31
Repository: `FutureUnicorn/AI-Filter`
Mode: read-only

## Purpose

This runbook defines how to compare Jira delivery state with GitHub pull requests, exact target-branch merge revisions, required CI, acceptance evidence, and native dependency links. A merge into a feature branch is not delivery to `develop` or `main`. A successful PR check is not a substitute for CI on the actual merge revision. Jira status remains a human decision.

The checked-in snapshot is [jira-reconciliation-2026-10-31.json](reports/jira-reconciliation-2026-10-31.json). It contains the full PR heads, bases, merge SHAs, CI run URLs, owners, evidence references, dependency results, confidence, and proposed actions.

## How the audit works

1. `config/delivery/historical-audit-candidates.json` lists a reviewed, bounded candidate set and code evidence. It does not contain credentials or Jira descriptions/comments.
2. `scripts/ci/audit-historical-delivery.mjs` re-fetches each Jira status, assignee, and native issue link; each referenced PR; and `CI / Required` on the exact target-branch merge SHA.
3. `.github/workflows/jira-historical-audit.yml` runs only by manual dispatch from protected default-branch code. It has read permissions and uploads JSON and Markdown evidence.
4. API failures produce `unknown` evidence and no correction proposal. The job has no Jira write or transition path.
5. A human reviews the report ticket by ticket before any comment, link, sprint, or status change.

## Current findings

- `origin/develop` was `bbe7aafd4a4ce3261263ca46ac9d267e43fd071d`.
- PR #83, #89, #94, and #95 have successful `CI / Required` runs on their exact `develop` merge commits.
- AF-103 meets its acceptance criteria in current code and is a Done candidate after human review of the evidence.
- AF-104 meets its code acceptance criteria, but Jira has no native AF-102 dependency link even though its description and comment name AF-102. Review the direction and add the link before a status transition.
- AF-67 has its code foundations and queue telemetry in `develop`; live Sentry provisioning, approved thresholds, notification ownership/routing, and staging trigger/recovery drills remain unverified. Keep it In Progress.
- AF-106 is a positive completed record. Claude was live-verified; Gemini and OpenAI-compatible behavior remains mock-only.
- AF-33 contains the requested counts, retry button, and downloadable error list. Its remaining evidence gap is browser-level verification; older statements that those controls are absent are stale.
- PRs #61-#71 and #76/#78 merged only branch into branch. PRs #72, #73, and #79 remain open against feature branches. Their tickets are not delivered to `develop`.
- PR #86 for AF-94 remains open, behind `develop`, and has changes requested.

## Current open PRs

| PR | Base | Head | Merge state | Review | Head checks |
|---|---|---|---|---|---|
| [#96](https://github.com/FutureUnicorn/AI-Filter/pull/96) | develop | `5b3998e17c2045be6d7d4f586c7a723a2baab265` | BLOCKED | REVIEW_REQUIRED | 14 successful rollup entries |
| [#86](https://github.com/FutureUnicorn/AI-Filter/pull/86) | develop | `22b90887950e461d92615510c49221475109085b` | BEHIND | CHANGES_REQUESTED | 14 successful rollup entries |
| [#79](https://github.com/FutureUnicorn/AI-Filter/pull/79) | fix/AF-96-stack-rls-parity | `b1b03ce9647b68145c30ff39e163baad22665f39` | CLEAN | CHANGES_REQUESTED | none reported |
| [#73](https://github.com/FutureUnicorn/AI-Filter/pull/73) | feature/AF-66-support-access-logging | `6daff589115afee7bbf0334a73639ff1689ecbc6` | CLEAN | CHANGES_REQUESTED | none reported |
| [#72](https://github.com/FutureUnicorn/AI-Filter/pull/72) | feature/AF-63-deletion-reconciliation | `5e2ab94fe586b325eeed9eaeaacd2006cc70237a` | CLEAN | CHANGES_REQUESTED | none reported |

PR-head checks do not prove delivery. Only successful required CI on an actual `develop` or `main` merge revision is target delivery evidence.

## Sprint lifecycle drift

AF Sprint 1 (board 34, sprint 484) is still `active`. It ran from 2026-10-12 through 2026-10-26. The current 44 issues comprise 19 Done, 23 In Review, and 2 In Progress. This differs from the earlier handoff snapshot of 5 Done because tickets were updated on 2026-10-31. Completing or extending the sprint is a separate board-owner action and was not performed.

## Ticket-by-ticket reconciliation

| Ticket | Jira | Delivery / PR evidence | Target CI | Acceptance | Dependency | Confidence | Proposed Jira action | Owner | Sources |
|---|---|---|---|---|---|---|---|---|---|
| AF-1 | In Review | aggregate-no-direct-pr<br>no direct PR | none verified | not-applicable: Epic status must be derived from reviewed child outcomes; it has no direct delivery PR. | none | high | Keep human control; review child-ticket outcomes rather than inferring epic completion from code merges. | Hemnaath B | [AF-1](https://hemnaathusa.atlassian.net/browse/AF-1) |
| AF-3 | In Review | aggregate-no-direct-pr<br>no direct PR | none verified | partial: Epic contains delivered work and child tickets that still have acceptance gaps. | none | high | Keep human control; review child-ticket outcomes rather than inferring epic completion from code merges. | saikrishnaa103 | [AF-3](https://hemnaathusa.atlassian.net/browse/AF-3) |
| AF-5 | In Review | aggregate-no-direct-pr<br>no direct PR | none verified | partial: Epic contains delivered review workflow foundations and undelivered stacked work. | none | high | Keep human control; review child-ticket outcomes rather than inferring epic completion from code merges. | Hemnaath B | [AF-5](https://hemnaathusa.atlassian.net/browse/AF-5) |
| AF-6 | In Review | aggregate-no-direct-pr<br>no direct PR | none verified | partial: Metric and audit-report work remains in a feature-branch stack that has not reached develop. | none | high | Keep human control; review child-ticket outcomes rather than inferring epic completion from code merges. | Hemnaath B | [AF-6](https://hemnaathusa.atlassian.net/browse/AF-6) |
| AF-24 | In Review | delivered-to-target<br>#83 -> develop; merge 6a5a36b | #83: Required success | partial: Roles list is delivered, but rubric approval, import readiness, and pipeline counts remain placeholders. | none | high | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | saikrishnaa103 | [AF-24](https://hemnaathusa.atlassian.net/browse/AF-24) [PR #83](https://github.com/FutureUnicorn/AI-Filter/pull/83) [CI 35311764272](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35311764272) |
| AF-28 | In Review | delivered-to-target<br>#83 -> develop; merge 6a5a36b | #83: Required success | partial: The private-bucket upload API is delivered, but there is no browser upload UI and the signed URL is reusable until expiry rather than one-use. | none | high | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | saikrishnaa103 | [AF-28](https://hemnaathusa.atlassian.net/browse/AF-28) [PR #83](https://github.com/FutureUnicorn/AI-Filter/pull/83) [CI 35311764272](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35311764272) |
| AF-33 | In Review | delivered-to-target<br>#83 -> develop; merge 6a5a36b | #83: Required success | unverified: Counts, retry, and error-download code are present; browser-level interaction evidence remains missing. | none | medium | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | saikrishnaa103 | [AF-33](https://hemnaathusa.atlassian.net/browse/AF-33) [PR #83](https://github.com/FutureUnicorn/AI-Filter/pull/83) [CI 35311764272](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35311764272) |
| AF-45 | In Review | delivered-to-target<br>#83 -> develop; merge 6a5a36b | #83: Required success | partial: The tenant-scoped queue is delivered, but the accepted evidence-processing state model remains unresolved. | none | high | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | Hemnaath B | [AF-45](https://hemnaathusa.atlassian.net/browse/AF-45) [PR #83](https://github.com/FutureUnicorn/AI-Filter/pull/83) [CI 35311764272](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35311764272) |
| AF-47 | In Review | delivered-to-target<br>#83 -> develop; merge 6a5a36b | #83: Required success | partial: Only extraction-state filters work; incomplete, contradiction, and error filters remain disabled. | none | high | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | Hemnaath B | [AF-47](https://hemnaathusa.atlassian.net/browse/AF-47) [PR #83](https://github.com/FutureUnicorn/AI-Filter/pull/83) [CI 35311764272](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35311764272) |
| AF-48 | In Review | delivered-to-target<br>#83 -> develop; merge 6a5a36b | #83: Required success | partial: Evidence cards and citations are delivered, but the original application document is not shown beside them. | none | high | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | Hemnaath B | [AF-48](https://hemnaathusa.atlassian.net/browse/AF-48) [PR #83](https://github.com/FutureUnicorn/AI-Filter/pull/83) [CI 35311764272](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35311764272) |
| AF-52 | In Review | stacked-not-delivered<br>#61 -> feature/AF-51-named-human-decision-recording; merge a06dc4c | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-52](https://hemnaathusa.atlassian.net/browse/AF-52) [PR #61](https://github.com/FutureUnicorn/AI-Filter/pull/61) |
| AF-53 | In Review | stacked-not-delivered<br>#62 -> feature/AF-52-low-evidence-audit-sampling; merge 8c5dd91 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-53](https://hemnaathusa.atlassian.net/browse/AF-53) [PR #62](https://github.com/FutureUnicorn/AI-Filter/pull/62) |
| AF-54 | In Review | stacked-not-delivered<br>#63 -> feature/AF-53-keyboard-first-review-navigation; merge a4482ce | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-54](https://hemnaathusa.atlassian.net/browse/AF-54) [PR #63](https://github.com/FutureUnicorn/AI-Filter/pull/63) |
| AF-55 | In Review | stacked-not-delivered<br>#66 -> feature/AF-54-capture-recruiter-review-timing; merge 6813479 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-55](https://hemnaathusa.atlassian.net/browse/AF-55) [PR #66](https://github.com/FutureUnicorn/AI-Filter/pull/66) |
| AF-56 | In Review | stacked-not-delivered<br>#67 -> feature/AF-55-review-time-reduction; merge dca1b13 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-56](https://hemnaathusa.atlassian.net/browse/AF-56) [PR #67](https://github.com/FutureUnicorn/AI-Filter/pull/67) |
| AF-57 | In Review | stacked-not-delivered<br>#68 -> feature/AF-56-qualified-candidate-preservation; merge 21188d7 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-57](https://hemnaathusa.atlassian.net/browse/AF-57) [PR #68](https://github.com/FutureUnicorn/AI-Filter/pull/68) |
| AF-59 | In Review | stacked-not-delivered<br>#69 -> feature/AF-57-evidence-precision-correction-rate; merge b5eb913 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-59](https://hemnaathusa.atlassian.net/browse/AF-59) [PR #69](https://github.com/FutureUnicorn/AI-Filter/pull/69) |
| AF-61 | In Review | stacked-not-delivered<br>#70 -> feature/AF-59-role-level-audit-report; merge f5195e6 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | saikrishnaa103 | [AF-61](https://hemnaathusa.atlassian.net/browse/AF-61) [PR #70](https://github.com/FutureUnicorn/AI-Filter/pull/70) |
| AF-62 | In Review | stacked-not-delivered<br>#76 -> feature/AF-65-retry-dead-letter-administration; merge 6daff58 | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | saikrishnaa103 | [AF-62](https://hemnaathusa.atlassian.net/browse/AF-62) [PR #76](https://github.com/FutureUnicorn/AI-Filter/pull/76) |
| AF-63 | In Review | stacked-not-delivered<br>#71 -> feature/AF-61-retention-policy; merge 7d7bb4d | none verified | unverified: The PR merged only into a feature branch; acceptance must be reverified after integration onto develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | saikrishnaa103 | [AF-63](https://hemnaathusa.atlassian.net/browse/AF-63) [PR #71](https://github.com/FutureUnicorn/AI-Filter/pull/71) |
| AF-65 | In Review | open-not-delivered<br>#73 -> feature/AF-66-support-access-logging; merge unmerged | none verified | unverified: The PR remains open against another feature branch and is not delivered to develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | saikrishnaa103 | [AF-65](https://hemnaathusa.atlassian.net/browse/AF-65) [PR #73](https://github.com/FutureUnicorn/AI-Filter/pull/73) |
| AF-66 | In Review | open-not-delivered<br>#72 -> feature/AF-63-deletion-reconciliation; merge unmerged | none verified | unverified: The PR remains open against another feature branch and is not delivered to develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | saikrishnaa103 | [AF-66](https://hemnaathusa.atlassian.net/browse/AF-66) [PR #72](https://github.com/FutureUnicorn/AI-Filter/pull/72) |
| AF-90 | In Review | open-not-delivered<br>#79 -> fix/AF-96-stack-rls-parity; merge unmerged | none verified | unverified: The stack-tip PR remains open against a feature branch and is not delivered to develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-90](https://hemnaathusa.atlassian.net/browse/AF-90) [PR #79](https://github.com/FutureUnicorn/AI-Filter/pull/79) |
| AF-94 | In Review | open-not-delivered<br>#86 -> develop; merge unmerged | none verified | unverified: The direct PR is open, behind develop, and has changes requested; it is not delivered. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Pradeep Sam | [AF-94](https://hemnaathusa.atlassian.net/browse/AF-94) [PR #86](https://github.com/FutureUnicorn/AI-Filter/pull/86) |
| AF-96 | In Review | stacked-not-delivered<br>#78 -> feature/AF-64-privacy-export-delete-requests; merge 2d5e833 | none verified | unverified: The RLS parity PR merged only into the feature stack and is not delivered to develop. | none | medium | Keep the ticket open; the referenced work is not delivered to develop or main. | Hemnaath B | [AF-96](https://hemnaathusa.atlassian.net/browse/AF-96) [PR #78](https://github.com/FutureUnicorn/AI-Filter/pull/78) |
| AF-103 | In Review | delivered-to-target<br>#94 -> develop; merge e26fffa | #94: Required success | met: Worker health logs distinguish database, object-storage, and combined failures with secret-free regression coverage. | none | high | Human owner may move this ticket to Done after reviewing the verified merge, CI, acceptance, and dependency evidence. | Hemnaath B | [AF-103](https://hemnaathusa.atlassian.net/browse/AF-103) [PR #94](https://github.com/FutureUnicorn/AI-Filter/pull/94) [CI 40085948768](https://github.com/FutureUnicorn/AI-Filter/actions/runs/40085948768) |
| AF-104 | In Review | delivered-to-target<br>#94 -> develop; merge e26fffa | #94: Required success | met: The deployed worker reaches budget telemetry on settled and capped paths, with an architecture guard against silent drift. | AF-102: missing link; Done | high | Review and correct the native Jira dependency link before any status transition. | Hemnaath B | [AF-104](https://hemnaathusa.atlassian.net/browse/AF-104) [PR #94](https://github.com/FutureUnicorn/AI-Filter/pull/94) [CI 40085948768](https://github.com/FutureUnicorn/AI-Filter/actions/runs/40085948768) [AF-102](https://hemnaathusa.atlassian.net/browse/AF-102) |
| AF-67 | In Progress | delivered-to-target<br>#89 -> develop; merge 588dc8a<br>#94 -> develop; merge e26fffa | #89: Required success<br>#94: Required success | partial: Monitoring code and queue telemetry are delivered; live Sentry provisioning, thresholds, routing ownership, and staging drills remain unverified. | AF-102: linked; Done | high | Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified. | saikrishnaa103 | [AF-67](https://hemnaathusa.atlassian.net/browse/AF-67) [PR #89](https://github.com/FutureUnicorn/AI-Filter/pull/89) [PR #94](https://github.com/FutureUnicorn/AI-Filter/pull/94) [CI 35684334613](https://github.com/FutureUnicorn/AI-Filter/actions/runs/35684334613) [CI 40085948768](https://github.com/FutureUnicorn/AI-Filter/actions/runs/40085948768) [AF-102](https://hemnaathusa.atlassian.net/browse/AF-102) |
| AF-106 | Done | delivered-to-target<br>#95 -> develop; merge bbe7aaf | #95: Required success | met: Provider adapters, safety controls, configuration, and tests are delivered; Claude alone was live-verified while Gemini and OpenAI-compatible remain mock-only. | none | high | No status change proposed; retain the verified completed record. | saikrishnaa103 | [AF-106](https://hemnaathusa.atlassian.net/browse/AF-106) [PR #95](https://github.com/FutureUnicorn/AI-Filter/pull/95) [CI 40909882279](https://github.com/FutureUnicorn/AI-Filter/actions/runs/40909882279) |

## No-code and non-PR exceptions

- Epics AF-1, AF-3, AF-5, and AF-6 are aggregate records. Their status must follow reviewed child outcomes; no single merge proves an epic complete.
- AF-67 contains operational acceptance outside a PR: real Sentry account/project configuration, notification routing, approved thresholds, and staging drills. These remain human and operations owned.
- Sprint completion is Jira administration, not code delivery.

## Running the audit

From a protected default-branch checkout with the approved Jira service credentials configured:

```bash
node --test scripts/ci/tests/historical-delivery-audit.test.mjs
node scripts/ci/audit-historical-delivery.mjs
```

Or dispatch **Historical GitHub-Jira Audit** in GitHub Actions. Review both uploaded files. Do not apply a proposal if the acceptance snapshot is stale; re-read the ticket, comments, dependencies, current code, PR review, and exact merge CI first.

## Recovery and correction procedure

1. For `unknown`, retry after API access recovers. Do not infer success.
2. For `missing-target-ci`, investigate or rerun the required target-branch CI for the exact merge SHA.
3. For `stacked-not-delivered` or `open-not-delivered`, integrate through a reviewed PR to `develop`; do not close the Jira ticket from branch-to-branch history.
4. For missing dependency links, verify the source and direction with the ticket owner, then propose one exact Jira link mutation for approval.
5. For a Done candidate, prepare one user-readable Jira comment that names the PR, target, full merge SHA, CI run, acceptance evidence, limitations, dependencies, and human owner. Obtain approval before posting or transitioning.
6. Preserve prior comments. Add or update only the service account stage-specific evidence marker after the trusted workflow is deployed.

## Implemented functionality and administrative rollout

Implemented in repository code:

- Canonical project policy and shared provider-independent skills.
- Report-only PR metadata validation.
- Trusted current-head Jira ready verification and a bot-owned ready-comment path.
- Verified post-merge evidence upsert and scheduled read-only reconciliation.
- Manual historical audit, candidate manifest, regression tests, and this evidence-backed snapshot.

Administrative configuration still required after these PRs are reviewed and merged:

- Create or approve the dedicated Jira governance issue used by the rollout PRs.
- Configure least-privilege `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_SERVICE_ACCOUNT_ID` secrets.
- Pilot the ready and post-merge workflows on a dedicated AF ticket and ordinary PR, including a stale-head negative control.
- Verify exact check contexts on ordinary PRs and any intended merge queue before changing rulesets.
- Add `Jira Handoff / Ready` to branch rules only after the pilot reports correctly and human approval remains required.
- Approve Jira comments, links, or status corrections ticket by ticket. No historical mutation was performed by this implementation.
