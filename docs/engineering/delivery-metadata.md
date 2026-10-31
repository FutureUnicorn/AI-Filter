# Pull request delivery metadata

**Policy:** AF-DELIVERY-1.0
**Validator:** `scripts/ci/validate-delivery-metadata.mjs`
**Check:** `Delivery Policy / PR Metadata (Report Only)`

The pull request description carries a readable handoff for people and one fenced JSON object for deterministic parsing. The JSON is a claim made by the contributor. It does not independently verify Jira, GitHub CI, reviews, deployments, or acceptance evidence.

## Structured fields

| Field | Required structure |
|---|---|
| `schemaVersion` | Exact value `1.0`. |
| `targetBase` | Intended base branch; compared with the actual pull request base. |
| `tickets` | One record per AF issue. Each has a unique Jira key and one or more acceptance criteria. |
| `tickets[].acceptance[]` | Unique criterion id, description, `Met` / `Unmet` / `Deferred` / `Not verified`, evidence entries, and remaining action with human owner. `Met` needs evidence. `Deferred` needs a matching approved exception. |
| `dependencies` | Declared ticket owner, relationship, reference, HTTPS source, native Jira link where applicable, current status, blocking stage, effect, owner, and next action. Stages are `review`, `merge`, `deployment`, `Done`, or `none`. |
| `tests` | Classification, exact command or procedure, full tested SHA, result, and evidence. Classifications are `automated`, `mocked`, `live`, `manual`, or `unverified`. |
| `humanEvidenceOwner` | Named human identity. An AI assistant cannot own or approve evidence. |
| `aiAssistance` | Provider and tool names, or an empty array for human-only work. |
| `rollout` | Plan and rollback or an accurate no-runtime-impact explanation. |
| `approvedExceptions` | Exact scope, human approver, expiry date, compensating control, and follow-up. An empty array means no approved exception. |
| `readyEvidence` | `null` for a draft. Before ready-for-review it contains the real PR number, base, current full head SHA, AI-Filter Actions URL, `passed` status, and one Jira comment URL per ticket. |

Readable ticket keys and acceptance rows must agree with the JSON. Unknown JSON fields fail structural validation so misspelled evidence cannot disappear silently.

## Report-only execution

The workflow uses the nonprivileged `pull_request` event with read-only contents permission and no secrets. It checks out the tested merge revision and executes contributor-controlled parser code in the same low-trust environment as ordinary CI. It reads the GitHub event file through `GITHUB_EVENT_PATH`; PR text is parsed as data and is never interpolated into a shell command.

This design makes gaps visible in the job log, warning annotations, and step summary. It remains report-only and must not be added to a required ruleset. A pull request can change its own parser until a trusted validator is deployed from protected workflow code.

The workflow deliberately does not use `pull_request_target`. That event runs with base-repository trust and can expose secrets or write permissions if untrusted code is later fetched or executed. GitHub documents the event source and risks in [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) and [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

The report-only check does not run for `merge_group`: that event represents a merge group and does not provide one authoritative PR description to validate. The existing `CI / Required` check remains the merge-queue-compatible required gate. Do not require the delivery metadata context until a later trusted design proves an exact context for every supported event.

## Local validation

Run the parser tests and either fixture:

```bash
node --test scripts/ci/tests/delivery-metadata.test.mjs
node scripts/ci/validate-delivery-metadata.mjs --file scripts/ci/tests/fixtures/valid-pr.md
node scripts/ci/validate-delivery-metadata.mjs --file scripts/ci/tests/fixtures/invalid-pr.md --report-only
```

The valid fixture demonstrates a passing draft. The invalid fixture deliberately retains placeholders and missing evidence so warning behavior remains testable.

## Promotion criteria

The structural check can move beyond report-only only after a protected implementation independently fetches the actual PR, base, head, Jira issues, authorized Jira comments, links, and CI conclusions. It also needs a real passing and failing pilot, fork behavior review, merge-queue decision, exact check-context verification, and an explicit ruleset update. Slice 3 implements the trusted Jira verification pilot; it does not inherit trust from this parser.
