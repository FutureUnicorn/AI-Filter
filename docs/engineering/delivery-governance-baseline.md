# Delivery governance baseline

**Observed:** 2026-10-31
**Repository:** `FutureUnicorn/AI-Filter`
**Develop revision:** `bbe7aafd4a4ce3261263ca46ac9d267e43fd071d`

## Repository and GitHub evidence

- GitHub default branch is `main`; ordinary feature integration targets `develop`.
- `develop` and `main` have active rulesets requiring one approval and `CI / Required`. Stale approvals are dismissed on push. The rulesets have no bypass actors.
- `.github/workflows/ci.yml` retains lint, typecheck, unit, integration, architecture, and build jobs plus the fail-closed `CI / Required` aggregate.
- CI runs for pull requests and pushes targeting `develop`, `main`, and `feature/**`, and declares `merge_group` support.
- Repository-wide assistant instructions, a contributor guide, a pull request template, shared project skills, Jira handoff checks, and reconciliation automation were absent.
- `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` already provide scoped Next.js guidance and remain intact.

## Current pull request evidence

| PR | Base | State observed | Delivery interpretation |
|---|---|---|---|
| #86 / AF-94 | `develop` | Open, behind, changes requested | Not delivered to current `develop`. |
| #72 / AF-66 | feature branch | Open, changes requested | Stacked work; not delivered to `develop`. |
| #73 / AF-65 | feature branch | Open, changes requested | Stacked work; not delivered to `develop`. |
| #79 / AF-90 | feature branch | Open, changes requested | Stack tip; not delivered to `develop`. |
| #94 / AF-103 and AF-104 | `develop` | Merged as `e26fffa65f1d80e086b53a3062ae2e7b6c86c1ae`; required CI succeeded | Code reached `develop`; Jira acceptance evidence is stale. |
| #95 / AF-106 | `develop` | Merged as `bbe7aafd4a4ce3261263ca46ac9d267e43fd071d`; required CI succeeded | Positive delivery record with explicit live-versus-mocked limitations. |

## Jira evidence

- No existing AF issue was found for repository delivery governance or GitHub-Jira reconciliation. This implementation must not invent a key or silently create one.
- AF-67 remains In Progress. PRs #89 and #94 delivered code foundations, while real Sentry configuration, thresholds, routing ownership, and staging trigger/recovery drills remain operational acceptance work.
- AF-103 and AF-104 remain In Review. Their visible comments describe the pre-merge branch state even though PR #94 reached `develop` with successful required CI.
- AF-106 is Done and has start, ready, CI, and merged comments. Its record correctly says Claude was live verified while Gemini and OpenAI-compatible behavior remained mock-only.
- AF Sprint 1 is still reported active although its configured end date was 2026-10-26. Sprint administration is separate from delivery evidence and requires board-owner action.

## Remediation matrix

| Gap | Planned slice | Enforcement state after slice |
|---|---|---|
| No shared policy or provider-neutral instructions | PR 1 | Guidance plus drift detection. |
| Free-form or incomplete PR descriptions | PR 2 | Report-only structural check. |
| Jira evidence can reference an old or invented SHA | PR 3 | Trusted API verification in pilot mode. |
| Post-merge Jira comments depend on memory | PR 4 | Trusted, idempotent write-back after target CI. |
| Historical status drift and stacked PR ambiguity | PR 5 | Read-only evidence report and correction proposals. |
| Checks are not required by branch rules | Administrative rollout | Enforced only after pilot and explicit ruleset update. |
| Jira Done transitions are not protected by delivery evidence | Future Jira governance review | Human controlled; no automatic transitions in this initiative. |

## Baseline limitations

This audit does not claim that every historical ticket's acceptance criteria have been verified. Historical corrections remain proposals until each ticket, dependency, merge target, and CI result is reviewed. No Jira status, comment, link, sprint, GitHub ruleset, or repository setting was changed during this baseline.
