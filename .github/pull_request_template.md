<!-- AF-DELIVERY-1.0. Replace every placeholder. Create the PR as a draft before adding its number, current head SHA, CI URL, and Jira ready-comment links. -->

## Jira and outcome

- Ticket: AF-[number] - [link and summary]
- Outcome: [plain-language result]
- User impact: [what an end user can do or observe]
- Scope exclusions: [what remains outside this PR]

## Acceptance criteria

| Ticket | Acceptance criterion | State (Met / Unmet / Deferred / Not verified) | Code or evidence | Remaining action and owner |
|---|---|---|---|---|
| AF-[number] | [criterion] | Not verified | [path or URL] | [action and human owner] |

## Dependencies

| Relationship | Item and source | Current status | Blocking stage (review / merge / deployment / Done / none) | Effect | Owner and next action |
|---|---|---|---|---|---|
| [blocks / is blocked by / depends on / related to] | [Jira or external link] | [status] | [stage] | [specific effect] | [owner and action] |

<!-- If no dependencies exist, replace the table with: None - [evidence-based reason]. -->

## Verification

| Classification (automated / mocked / live / manual / unverified) | Command or procedure | Revision | Result | Evidence |
|---|---|---|---|---|
| automated | `pnpm check` | [full SHA] | Not run | [CI URL or reason] |

## Security, product boundary, and operations

- Product policy: [evidence-only and human-decision impact]
- Tenant isolation, authorization, privacy, audit, prompt injection, and secrets: [reviewed impact]
- Rollout: [steps and prerequisites]
- Rollback: [steps or no-runtime-impact reason]
- Deployment or operational evidence still required: [items and owners]

## AI assistance and accountability

- Human evidence owner: [GitHub or team identity]
- AI assistance: [providers/tools or None]
- Independent reviewer: Pending human review
- Approved exceptions: None

## Jira ready-for-review handoff

- PR number: [number after draft creation]
- Target base: [base]
- Current head SHA: [40-character SHA]
- Current-head CI: [URL and conclusion]
- Per-ticket Jira ready comments: [links]

## Structured delivery metadata

<!-- Keep this JSON valid. PR 2 introduces report-only schema validation. PR 3 independently verifies the external values. -->

```json
{
  "schemaVersion": "1.0",
  "targetBase": "develop",
  "tickets": [
    {
      "key": "AF-000",
      "acceptance": [
        {
          "id": "AC-1",
          "description": "Replace with the acceptance criterion",
          "status": "Not verified",
          "evidence": [],
          "remainingAction": "Name the action and human owner"
        }
      ]
    }
  ],
  "dependencies": [],
  "tests": [],
  "humanEvidenceOwner": "github-login",
  "aiAssistance": [],
  "rollout": {
    "plan": "Replace with rollout or no-runtime-impact reason",
    "rollback": "Replace with rollback or no-runtime-impact reason"
  },
  "approvedExceptions": [],
  "readyEvidence": null
}
```
