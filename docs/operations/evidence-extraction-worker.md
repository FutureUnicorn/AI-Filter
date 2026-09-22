# Durable evidence-extraction worker

AF-102 adds a PostgreSQL-backed queue and a hosted Node worker. The authenticated
enqueue endpoint accepts a validated PDF/DOCX intake for an application and the
role's latest published rubric. The logical key
`application + source intake + rubric + workflow version` makes enqueue replay
safe without treating the recruiter review list as a processing queue.

The worker is disabled unless `WORKER_PROCESSING_ENABLED=true`. When enabled,
configure a stable `WORKER_INSTANCE_ID`, provider credentials/models, the
token cap/warning ratio/period, and the bounded lease/retry values documented in
`.env.example`. Heartbeats must be less than half the lease duration. The
container publishes no worker port to the host; its public network attachment
exists only for outbound provider calls.

Processing order is: claim under `FOR UPDATE SKIP LOCKED`, validate durable job
context, scan the canonical document for prompt injection, select a model,
reserve the token budget, call the provider with retention disabled, settle
provider usage, validate/map citations, and atomically record the immutable run,
outcomes, and completed state. Kill-switch and budget-cap pauses return the job
to ready state without consuming a retry. Provider/parse failures use bounded
exponential backoff; an expired lease is reclaimable and stale owners cannot
complete it.

Operationally inspect `getEvidenceExtractionQueueMonitoringSnapshot` for oldest
ready age, ready/running/completed/failed counts, attempts, and heartbeat age.
Per-job timestamps support queue wait and duration through
`deriveEvidenceExtractionJobTiming`. Failure codes are bounded machine values;
job rows, logs, and monitoring telemetry contain no candidate names, emails,
filenames, document text, prompts, quotes, or raw provider responses.
Retryable attempts do not page as terminal job failures. Once the durable
retry transition returns `failed`, the worker emits a bounded
`worker.job_failed` log and Sentry error with only the closed failure code and
safe diagnostic classification. Failures while recording an unexpected retry
transition are reported separately without changing worker control flow.

Before enabling real data, run `pnpm check`, deploy the exact green SHA to
staging, enqueue only a synthetic document, and drill: successful completion,
duplicate enqueue, concurrent claim exclusivity, expired-lease recovery,
bounded retry exhaustion, kill-switch deferral, budget warning/cap telemetry,
and worker heartbeat staleness. Keep the AF-67 queue-age detector disabled until
its external threshold is approved and its Sentry publication path is drilled.
