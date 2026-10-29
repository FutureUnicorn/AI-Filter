# Durable evidence-extraction worker

AF-102 adds a PostgreSQL-backed queue and a hosted Node worker. The authenticated
enqueue endpoint accepts a validated PDF/DOCX intake for an application and the
role's latest published rubric. The logical key
`application + source intake + rubric + workflow version` makes enqueue replay
safe without treating the recruiter review list as a processing queue.

The worker is disabled unless `WORKER_PROCESSING_ENABLED=true`. When enabled,
configure `WORKER_INSTANCE_ID` as a recognizable deployment/instance label,
provider credentials/models, the token cap/warning ratio/period, and the bounded
lease/retry values documented in `.env.example`. Each process appends a unique
boot ID to that label; replicas and restarted processes therefore own distinct
leases and heartbeat rows. Heartbeats must be less than half the lease duration. The
container publishes no worker port to the host; its public network attachment
exists only for outbound provider calls.

`AI_PROVIDER` selects the adapter and defaults to `openai` when blank. The
required provider settings are:

| Provider | Required settings |
| --- | --- |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_ESCALATION_MODEL` |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_ESCALATION_MODEL` |
| `google` | `AI_API_KEY`, `AI_MODEL`, `AI_ESCALATION_MODEL` |
| `openai_compatible` | `AI_API_KEY`, `AI_MODEL`, `AI_ESCALATION_MODEL`, `AI_BASE_URL` |

`ANTHROPIC_MAX_OUTPUT_TOKENS` controls Claude's required per-call generation
ceiling and defaults to `4096`. Increase it when larger rubrics or quotations
need more structured output. A response stopped at that ceiling is recorded
with its real usage and retried as a distinct truncation failure.

`AI_BASE_URL` is worker-only configuration. It must use HTTPS except for
localhost or loopback development servers, and it cannot contain credentials,
a query string, or a fragment. The web service receives none of the provider
keys or provider endpoint settings in `infra/compose/runtime.yml`.

Only Claude has been live-verified for AF-106. Google Gemini and
OpenAI-compatible adapters are covered by mocked transport tests only and must
receive a live smoke test before operators describe them as live-supported.
Every provider produces factual evidence through the same schema. The output
remains evidence for recruiter review; it does not rank candidates, make hiring
decisions, or write decisions to an ATS.

Processing order is: claim under `FOR UPDATE SKIP LOCKED`, validate durable job
context, scan the canonical document for prompt injection, select a model,
reserve the token budget, call the provider with structured output enforced
(and response retention explicitly disabled for the OpenAI Responses API), settle
provider usage, validate/map citations, and atomically record the immutable run,
outcomes, and completed state. Kill-switch and budget-cap pauses return the job
to ready state without consuming a retry. Provider/parse failures use bounded
exponential backoff; an expired lease is reclaimable and stale owners cannot
complete it. Every lifecycle mutation is fenced by both runtime owner and
claim-attempt number, including when a replacement attempt happens to use the
same configured label.

The first eligible enqueue durably binds an application to its validated source
intake. A later request cannot silently substitute another same-role
candidate's document. A terminal failed job can be deliberately submitted
again: the same logical row is reset to ready with a fresh retry budget, and the
endpoint returns `202` with `requeued: true`.

Operationally inspect `getEvidenceExtractionQueueMonitoringSnapshot` for oldest
ready age, ready/running/completed/failed counts, attempts, and heartbeat age.
Per-job timestamps support queue wait and duration through
`deriveEvidenceExtractionJobTiming`. Failure codes are bounded machine values;
job rows, logs, and monitoring telemetry contain no candidate names, emails,
filenames, document text, prompts, quotes, or raw provider responses.
Retryable attempts do not page as terminal job failures. Once the durable
retry transition returns `failed`, the worker emits a bounded
`worker.job_failed` log and Sentry error with only the closed failure code and
safe diagnostic classification. Every terminal path, including exhausted crash
leases and unexpected failures, records safe per-criterion failed outcomes.
Machine completion never replaces a current recruiter correction. Failures
while recording an unexpected retry transition are reported separately without
changing worker control flow.

Every granted inference reservation is settled. Provider responses with actual
usage settle that usage; typed pre-provider failures and HTTP rejection
responses release the estimate to zero. Ambiguous connection loss after
dispatch settles the conservative estimate because provider billing may still
have occurred. This prevents both phantom open reservations and silent
under-counting.

Before enabling real data, run `pnpm check`, deploy the exact green SHA to
staging, enqueue only a synthetic document, and drill: successful completion,
duplicate enqueue, concurrent claim exclusivity, expired-lease recovery,
bounded retry exhaustion, kill-switch deferral, budget warning/cap telemetry,
and worker heartbeat staleness. Keep the AF-67 queue-age detector disabled until
its external threshold is approved and its Sentry publication path is drilled.
