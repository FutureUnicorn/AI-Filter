## Jira and outcome

- Ticket: AF-106 - https://hemnaathusa.atlassian.net/browse/AF-106
- Outcome: Provider-neutral evidence extraction configuration.
- User impact: Operators can select a supported evidence provider while humans retain every hiring decision.
- Scope exclusions: Live Gemini verification remains outside this example.

## Acceptance criteria

| Ticket | Acceptance criterion | State | Code or evidence | Remaining action and owner |
|---|---|---|---|---|
| AF-106 | Provider selection preserves the evidence contract | Met | tests/integration/ai-provider-adapters.test.ts | None; human reviewer confirms the evidence |

## Dependencies

None - the code-delivery scope has no unresolved merge or deployment dependency.

## Verification

| Classification | Command or procedure | Revision | Result | Evidence |
|---|---|---|---|---|
| automated | corepack pnpm test:unit | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | passed | local output recorded in the PR |
| mocked | node --test tests/integration/ai-provider-adapters.test.ts | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | passed | tests/integration/ai-provider-adapters.test.ts |
| unverified | live Gemini transport | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | not-run; follow-up required | AF-106 limitation |

## Security, product boundary, and operations

- Product policy: AI produces evidence and humans decide.
- Tenant isolation: no tenant behavior changes.
- Rollout: Review and merge through the protected develop branch.
- Rollback: Revert the change; no data migration is involved.

## AI assistance and accountability

- Human evidence owner: Jane Engineer
- AI assistance: OpenAI Codex
- Independent reviewer: Pending human review
- Approved exceptions: None

## Jira ready-for-review handoff

- PR number: 96
- Target base: develop
- Current head SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Current-head CI: Pending while this pull request is a draft
- Per-ticket Jira ready comments: Pending while this pull request is a draft

## Structured delivery metadata

```json
{
  "schemaVersion": "1.0",
  "targetBase": "develop",
  "tickets": [
    {
      "key": "AF-106",
      "acceptance": [
        {
          "id": "AC-1",
          "description": "Provider selection preserves the evidence contract",
          "status": "Met",
          "evidence": [
            "tests/integration/ai-provider-adapters.test.ts"
          ],
          "remainingAction": "None; human reviewer confirms the evidence"
        }
      ]
    }
  ],
  "dependencies": [],
  "tests": [
    {
      "classification": "automated",
      "command": "corepack pnpm test:unit",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "result": "passed: 248 tests",
      "evidence": "Local command output recorded in the pull request"
    },
    {
      "classification": "mocked",
      "command": "node --test tests/integration/ai-provider-adapters.test.ts",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "result": "passed with deterministic provider mocks",
      "evidence": "tests/integration/ai-provider-adapters.test.ts"
    },
    {
      "classification": "unverified",
      "command": "live Gemini transport",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "result": "not-run; follow-up required",
      "evidence": "AF-106 limitation"
    }
  ],
  "humanEvidenceOwner": "Jane Engineer",
  "aiAssistance": [
    "OpenAI Codex"
  ],
  "rollout": {
    "plan": "Review and merge through the protected develop branch.",
    "rollback": "Revert the change; no data migration is involved."
  },
  "approvedExceptions": [],
  "readyEvidence": null
}
```
