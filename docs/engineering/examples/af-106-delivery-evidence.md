# AF-106 delivery evidence example

This historical example demonstrates readable and revision-bound evidence. It is not a substitute for re-reading current Jira and GitHub state.

## Delivery update - Merged

### What changed

AI-Filter can select OpenAI, Anthropic, Google Gemini, or an OpenAI-compatible endpoint through one evidence-extraction adapter. Provider selection does not change the evidence schema or allow the system to make hiring decisions.

### User impact

An operator can configure a supported provider for evidence extraction. Recruiters still review source-cited evidence and named humans remain responsible for decisions.

### Current state

Merged to `develop` through PR #95. GitHub reports successful required CI for the resulting develop revision.

### Acceptance criteria

| Requirement | State | Evidence | Remaining action |
|---|---|---|---|
| Common schema and routing for all configured providers | Met | Provider adapter integration tests and PR #95 | None for code delivery |
| Missing settings fail safely without exposing secrets | Met | Configuration and adapter negative tests | None for code delivery |
| Token usage and kill switch apply to each provider | Met | Provider integration tests | None for code delivery |
| At least one non-OpenAI provider is live verified | Met | Claude `claude-haiku-5-5` smoke test recorded on AF-106 | Gemini and OpenAI-compatible remain mock-only |

### Dependencies

None identified for merging the code. Production use of a provider still depends on operator-managed credentials, approved models, and provider availability.

### Verification

- Automated: lint, typecheck, unit, integration, architecture, build, and `CI / Required` succeeded on GitHub.
- Live: Claude `claude-haiku-5-5` was exercised against the provider service.
- Mocked: Gemini and OpenAI-compatible transports were exercised with deterministic mocks.
- Unverified: live Gemini and OpenAI-compatible operation.

### Traceability

- Jira: AF-106
- Pull request: https://github.com/FutureUnicorn/AI-Filter/pull/95
- PR head: `2bc41f58535f5c5afe4ff8e90ed713f7df283dda`
- Develop merge: `bbe7aafd4a4ce3261263ca46ac9d267e43fd071d`
- Required CI: https://github.com/FutureUnicorn/AI-Filter/actions/runs/40886443658
- Human evidence owner: project maintainer recorded in Jira/GitHub

### Recommendation

AF-106 can be recommended for Done for the stated code scope. The recommendation retains the explicit limitation that Gemini and OpenAI-compatible providers were not live verified.

```text
[AF-DELIVERY v1 stage=merged repo=FutureUnicorn/AI-Filter pr=95 merge=bbe7aafd4a4ce3261263ca46ac9d267e43fd071d]
```
