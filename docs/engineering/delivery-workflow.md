# AI-Filter engineering delivery policy

**Policy ID:** AF-DELIVERY-1.0
**Status:** Adopted guidance; automated enforcement is activated only after verified rollout.
**Scope:** Human and AI-assisted work that can reach `develop` or `main`, including stacked branches.

## 1. Authority and precedence

This document is the single source of truth for the engineering delivery process. These repository contracts remain authoritative in their domains:

1. `docs/PRODUCT_BOUNDARY.md` defines binding product behavior. AI produces source-cited evidence and named humans decide. Ranking, scoring, automated employment decisions, automatic contact, ATS status writes, protected-characteristic inference, and cross-employer aggregation remain prohibited.
2. `docs/engineering/ci.md`, `.github/workflows/ci.yml`, and architecture tests define required code validation and release gates.
3. Scoped instructions such as `apps/web/AGENTS.md` add framework-specific requirements and apply together with this policy.
4. The assigned Jira issue defines scope and acceptance criteria unless it conflicts with a higher-priority product, privacy, security, or approved architectural decision.

Provider adapter files and project skills reference this policy instead of copying it. Instructions guide behavior; trusted GitHub, CI, Jira, and human review evidence determine compliance. An AI assistant cannot approve its own work or serve as the human evidence owner.

## 2. Delivery states

| State | Required evidence | Meaning |
|---|---|---|
| Investigating | Current Jira issue, dependencies, current `origin/develop`, acceptance map | Scope is being verified before implementation. |
| Implementing | Isolated branch, scoped changes, local evidence | Work is in progress and is not ready for review. |
| Draft PR | Real PR number, base, head SHA, incomplete checks identified | Remote evidence can now be collected. |
| Ready for review | Current-head CI, current Jira ready handoff, human owner | A human reviewer can evaluate the change. |
| Blocked | Blocker, stage affected, owner, next action | Work cannot complete the named stage. |
| Merged | Authoritative target, merge revision, target-branch CI | Code reached a protected target branch. |
| Reconciled | Jira and GitHub evidence agree, limitations remain explicit | Delivery records are current. |

`Merged` does not automatically mean deployed, product accepted, or Done. A feature-branch merge does not mean delivery to `develop`.

## 3. Investigate before coding

Before editing:

1. Read the complete Jira description, acceptance criteria, comments, subtasks, native issue links, and referenced decisions. Do not infer scope or status from a title.
2. Fetch current `origin/develop` and inspect the actual target branch. The repository default branch is `main`; ordinary integration work targets `develop`.
3. Read applicable repository instructions, architecture, existing implementations, configuration, infrastructure, documentation, and tests. Reuse established contracts.
4. Map every acceptance criterion to an implementation location, test or evidence path, current status, and remaining decision.
5. Classify dependencies as `blocks`, `is blocked by`, `depends on`, or `related to`. Record the stage affected: review, merge, deployment, or Done.
6. Identify concrete risks involving product policy, authorization, tenant isolation, applicant data, audit integrity, prompt injection, provider failures, usage accounting, schema changes, CI, operations, and rollback where applicable.
7. Create or update an understandable Jira **Delivery update - Started** comment through an authorized integration. Include scope, baseline SHA, acceptance plan, dependencies, risks, human owner, and next validation.

If Jira is unavailable, record the outage in the pull request and never claim the Jira handoff occurred. Ambiguous acceptance criteria or blocking decisions require human resolution.

## 4. Implement and verify before a pull request

- Keep changes limited to the ticket and preserve package boundaries, test registration, pinned toolchains, privacy controls, and existing APIs unless the ticket explicitly changes them.
- Add tests for observable behavior and realistic failure paths. Include security, data integrity, authorization, idempotency, and negative controls when their risk is present.
- Run applicable local validation. Use `pnpm check` when required services and environment are available. Compare suspected platform-specific baseline failures against a clean current `develop` revision.
- Record exact command, result, revision, environment, and evidence. Use `automated`, `mocked`, `live`, `manual`, and `unverified`. A mocked provider transport does not prove live provider support.
- Never place secrets, applicant data, resumes, raw prompts, provider responses, or candidate evidence in logs, fixtures, pull requests, or Jira comments.
- Review the complete diff and exclude unrelated or local-only files before committing.

A PR number and final head SHA do not exist before PR creation. Pre-PR evidence must not invent them. Create a draft pull request to collect remote evidence.

## 5. Pull request metadata and ready handoff

Every non-automated pull request uses `.github/pull_request_template.md` and includes:

- Jira key and link for every affected ticket.
- Plain-language outcome and user impact.
- A per-ticket acceptance table with requirement, `Met`, `Unmet`, `Deferred`, or `Not verified`, evidence, and remaining owner/action.
- A dependency table containing relationship, source, current status, affected stage, effect, owner, and next action. Jira dependencies use native links as well as readable explanations.
- Exact verification evidence and honest live, mocked, manual, or unverified classification.
- Product-policy, tenant, privacy, security, rollout, and rollback impact.
- A named human evidence owner and the AI tools used, or `None`.
- Remaining operational, deployment, or acceptance work.

`Deferred` requires an explicit approved scope decision, owner, and follow-up. Work that is incomplete without an approved deferral remains `Unmet`.

After the draft PR exists and intended checks complete, create or update one Jira **Delivery update - Ready for review** comment per ticket. It identifies the PR, base, current full head SHA, CI evidence, acceptance state, dependencies, limitations, and human owner. End it with:

```text
[AF-DELIVERY v1 stage=ready repo=FutureUnicorn/AI-Filter pr=<number> head=<40-char-sha>]
```

A new push invalidates prior ready evidence. A material scope edit or base change also requires refreshed evidence. A marker copied by an unauthorized user is not trusted proof; later enforcement verifies the Jira author and GitHub state independently.

## 6. Understandable and traceable Jira comments

Delivery comments serve end users, product owners, reviewers, and automation. Put the readable explanation first and the marker last.

Each comment contains:

1. **What changed:** the outcome in product language.
2. **User impact:** what users can do or observe, including an accurate no-impact statement where relevant.
3. **Current state:** started, ready, blocked, merged, superseded, or needs attention.
4. **Acceptance criteria:** requirement, state, evidence, and remaining action.
5. **Dependencies:** relationship, linked item, current status, affected stage, effect, owner, and next action.
6. **Verification:** exact command or CI link with automated, mocked, live, manual, or unverified classification.
7. **Traceability:** Jira key, PR, base, head or merge SHA, CI run, and human evidence owner.
8. **Recommendation:** the next Jira status, clearly separated from an actual transition.

Tailor multi-ticket comments to each ticket. Do not paste one generic statement across issues. Keep one bot-owned record per ticket, PR, and stage and update it on retry. Never edit another person's comment.

## 7. Dependency rules

| Relationship | Meaning | Required detail |
|---|---|---|
| `blocks` | This work prevents another item from completing. | Affected item, criterion, stage, owner. |
| `is blocked by` | Another item prevents this work from completing a stage. | Blocker evidence, stage, owner, next action. |
| `depends on` | A prerequisite can affect review, merge, deployment, or Done. | Exact affected stage and why. |
| `related to` | Context is useful but does not block this work. | Why it is non-blocking. |

Native Jira links provide navigation and relationship direction. Comments explain current impact. Re-read Jira status during every handoff. An unresolved blocker prevents a Done recommendation. A dependency can allow review or merge while blocking deployment or Done, but that distinction must be explicit and human approved.

## 8. Review remediation

For every review finding:

1. Reproduce and verify the finding against the current code.
2. Classify it as valid, invalid, or already addressed with evidence.
3. Fix the underlying issue with the smallest safe change and meaningful regression coverage.
4. Reply in the original review thread when requested.
5. Rerun affected validation and remote CI.
6. Refresh Jira ready evidence for the new head SHA.

Do not resolve another person's review thread or dismiss a review. A push can dismiss approvals under the repository ruleset and requires a new independent approval.

## 9. Post-merge evidence

A trusted workflow may create **Delivery update - Merged** only after it verifies:

- The PR was merged into `develop` or an explicitly approved target.
- The merge or resulting target revision is authoritative.
- `CI / Required` succeeded for that target revision.
- The PR and current Jira ticket mapping are unambiguous.
- Acceptance and dependency limitations remain accurately represented.

The bot upserts one comment per ticket, PR, and stage using:

```text
[AF-DELIVERY v1 stage=merged repo=FutureUnicorn/AI-Filter pr=<number> merge=<40-char-sha>]
```

The bot can recommend Done. It must not transition Jira until protected transition governance, exceptions, and human authority have been separately reviewed and enabled.

## 10. Trust boundaries and enforcement

- `Delivery Policy / PR Metadata` performs fast, no-secret structural validation on untrusted PR metadata.
- `Jira Handoff / Ready` runs only from trusted workflow code and verifies ticket existence, authorized comment author, actual PR/base/head, current CI, native links, blockers, and markers.
- A credential-bearing workflow must never check out or execute PR-head code, install PR dependencies, interpolate PR text into shell, or trust PR artifacts as commands.
- Jira credentials use a least-privilege service account and never appear in logs, repository files, artifacts, or comments.
- Enforcement paths fail closed when Jira state cannot be verified. Scheduled reconciliation can report `unknown` without inventing success.
- Existing six CI jobs, `CI / Required`, human approval, and product-policy controls remain in place.
- Required checks are activated in GitHub rulesets only after their exact contexts succeed on a real pilot for supported events.

The default branch is `main`, while normal work targets `develop`. Privileged event source semantics must be verified before rollout. Workflow files alone do not activate repository rulesets or Jira governance.

## 11. Reconciliation and exceptions

Reconciliation is read-only by default. It reports merged PRs lacking closure evidence, stale ready SHAs, Jira Done without verified merge or documented no-code evidence, missing native dependency links, unresolved blockers, duplicate bot records, superseded stacks, and overdue sprint administration.

Historical corrections require ticket-by-ticket evidence and explicit authorization. Never mass-transition Jira issues. An exception records issue, scope, reason, human approver, expiry, compensating control, and follow-up. Product-boundary, secret, privacy, tenant-isolation, required-CI, and human-approval controls cannot be waived by an AI assistant.

## 12. Rollout states

1. **Guidance:** canonical policy, provider adapters, project skills, PR template, and drift tests.
2. **Report only:** structural PR metadata check reports gaps without changing branch rules.
3. **Trusted pilot:** Jira service account, current-SHA verification, and idempotent comments are tested on a dedicated ticket and PR.
4. **Enforced:** exact verified checks are added to `develop` and `main` rulesets through a reviewed administrative change.
5. **Reconciled:** scheduled reporting runs, and approved historical corrections are applied individually.

Documentation or workflow files existing in the repository do not by themselves mean the system is enforced.
