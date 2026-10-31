# Delivery governance rollout

This document distinguishes repository functionality from administrative activation. The canonical process is `docs/engineering/delivery-workflow.md`.

## Incremental delivery

| Slice | Repository functionality | Administrative dependency |
|---|---|---|
| PR 1 | Policy, provider adapters, project skills, PR template, examples, drift guards | None; guidance only. |
| PR 2 | Structural metadata schema, deterministic parser/tests, report-only workflow | Workflow must first exist on the branch GitHub uses for the selected event. |
| PR 3 | Trusted Jira ticket, link, comment-author, PR/base/head, and CI verification | Jira bot identity and secret configuration; protected workflow source; pilot. |
| PR 4 | Verified post-merge comment upsert and scheduled read-only reconciliation | Jira write permission, concurrency policy, target-branch CI mapping. |
| PR 5 | Historical drift report and evidence-backed correction proposals | Ticket-by-ticket human approval before any correction. |

## Activation checklist

- [ ] Review AF-DELIVERY-1.0 and provider adapters.
- [ ] Run architecture drift tests and verify scoped `apps/web/AGENTS.md` remains intact.
- [ ] Pilot structural metadata on a deliberately failing and a passing pull request.
- [ ] Create a least-privilege Jira service account that can read issues, links, comments, and status, and can write only delivery comments when post-merge sync is enabled.
- [ ] Store Jira credentials only in the approved GitHub secret scope.
- [ ] Deploy privileged workflow definitions from the trusted branch required by GitHub event semantics.
- [ ] Pilot current-head ready verification on a dedicated AF ticket and pull request.
- [ ] Prove a push makes prior ready evidence stale.
- [ ] Prove retries update the bot's own comment instead of duplicating it.
- [ ] Prove feature-branch merges cannot be reported as delivered to `develop`.
- [ ] Verify exact check contexts for ordinary pull requests and any enabled merge queue.
- [ ] Add the verified checks to `develop` and `main` rulesets through an explicit ruleset update reviewed by administrators.
- [ ] Keep Jira transitions human controlled until protected transition governance is separately approved.

## Recovery

If a trusted Jira check fails because Jira is unavailable, the check reports an unavailable dependency and is retried after recovery. It must not report success from cached or self-declared PR data. If post-merge write-back fails, reconciliation reports the missing record and a controlled replay updates the same bot-owned marker.

Removing a required check from a ruleset, changing credential scope, enabling Jira transitions, or weakening product and human approval controls requires explicit administrative review.
