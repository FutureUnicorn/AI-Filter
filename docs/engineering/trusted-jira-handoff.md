# Trusted Jira ready-for-review verification

**Policy:** AF-DELIVERY-1.0
**Workflow:** `.github/workflows/jira-handoff.yml`
**Check:** `Jira Handoff / Ready`

## What is verified

The trusted verifier re-fetches authoritative state instead of accepting the pull request description as proof. It requires:

- one open, non-draft pull request associated with a successful `CI` workflow run;
- the current pull request head SHA to equal that run's head SHA;
- the `CI / Required` job to have completed successfully;
- structurally valid delivery metadata for the actual PR number, base, title, and head;
- an existing Jira issue for every declared AF key;
- a focused Jira comment URL for each ticket;
- the comment author account ID to equal the configured Jira service account;
- the exact marker `[AF-DELIVERY v1 stage=ready repo=FutureUnicorn/AI-Filter pr=<number> head=<full-sha>]`;
- every declared Jira-to-Jira dependency to exist with the claimed native link direction;
- no unresolved dependency classified as blocking review or merge.

Unresolved deployment and Done-stage dependencies remain visible as limitations. They do not claim deployment or ticket completion. External dependencies classified as review or merge blockers fail closed because the workflow cannot independently verify their status.

The verifier does not transition Jira issues, create or edit Jira comments, approve a PR, or decide that acceptance criteria are complete. The separate manually dispatched `Prepare Jira Ready Comment` workflow provides the authorized, idempotent ready-comment path. Slice 4 supplies idempotent post-merge writes and reconciliation.

## Trigger and trust boundary

The workflow uses two protected-code triggers:

1. `workflow_run` after `CI` completes, to verify the exact run and publish the current-head result.
2. `pull_request_target` only for opening, metadata edits, review readiness, reopen, synchronize, and conversion back to draft. This closes the stale-check gap when a PR body changes without a commit.

Both triggers execute the workflow and scripts from the repository default branch. Checkout explicitly selects `github.event.repository.default_branch`, never a PR ref or workflow-run head. The credential-bearing job installs no dependencies, downloads no artifacts, and executes no pull request code. PR event data supplies identifiers only; the script re-fetches the PR, head, CI run, jobs, Jira issues, links, and comments through APIs.

All PR text and Jira content are untrusted data. The script does not invoke a shell, render ADF, or expose response bodies in errors. API credentials are sent only to the fixed GitHub and AI_FILTER Jira origins. Jira 429 and 5xx responses use three bounded attempts with a maximum five-second delay.

## Required administrative configuration

Repository files alone do not activate this control. Complete these steps in order:

1. Review and merge the trusted workflow through the normal protected branch process.
2. Promote the reviewed workflow to the repository default branch, currently `main`; GitHub sources `workflow_run` and `pull_request_target` workflows there.
3. Create a dedicated Jira service account with read access to AF issues, statuses, links, and comments plus permission to create and update delivery comments. Do not grant transition, issue-edit, or project-administration rights.
4. Add these GitHub Actions secrets at the narrowest approved scope:
   - `JIRA_BASE_URL`: exactly `https://hemnaathusa.atlassian.net`
   - `JIRA_EMAIL`: service-account login email
   - `JIRA_API_TOKEN`: service-account API token
   - `JIRA_SERVICE_ACCOUNT_ID`: immutable Jira account ID used to verify comment authorship
5. Run a pilot with a dedicated AF issue and PR. Prove a valid marker passes, a copied human-authored marker fails, a new push invalidates the old SHA, a body edit reruns verification, and Jira unavailability fails closed.
6. Confirm the workflow's `checks:write` permission creates the exact `Jira Handoff / Ready` check on the PR head.
7. Only after the pilot, update the `develop` and `main` rulesets to require the exact context. Verify ordinary PR behavior and decide merge-queue support before enabling a merge queue.

Until all seven steps are complete, this is implemented pilot functionality and must not be described as enforced.

## Service comment contract

The service comment should be understandable without the machine marker:

1. plain-language outcome and user impact;
2. acceptance-criterion status with code, test, and CI links;
3. dependency effects, owners, next actions, and blocking stage;
4. test classifications, exact current head, target base, and limitations;
5. the marker on its own final line.

A push, retarget, material PR edit, or superseding PR requires refreshed evidence for the current state. The verifier reads comments and never edits a person's comment.

## Local validation

```bash
node --test scripts/ci/tests/jira-handoff.test.mjs
node --test tests/architecture/jira-handoff-workflow.test.ts
```

Tests use mocked HTTP transports. No live Jira comment write, live secret, ruleset update, or Jira transition is performed by this slice.


## Preparing the ready comment

The `Prepare Jira Ready Comment` workflow is a manual, trusted handoff path for contributors who do not have a private Jira connector:

1. Keep the PR as a draft and fill every metadata field except `readyEvidence`, which remains `null`.
2. Push the current revision and wait for `CI / Required` to pass.
3. From the default branch workflow, dispatch `Prepare Jira Ready Comment` with the real PR number.
4. Copy each returned focused-comment URL into `readyEvidence.jiraComments`, set the authoritative CI URL and full head SHA, and mark the PR ready.
5. The trusted verifier re-fetches and verifies the resulting state.

The dispatch updates one service-account-owned comment for the same issue, ready stage, and PR. It creates a new comment when none exists, never edits a human-authored copied marker, stops on duplicate bot comments, and refuses to add a ready-for-review comment to a Jira issue already in a Done status category. It does not transition any issue.