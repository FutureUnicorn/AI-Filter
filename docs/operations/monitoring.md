# AF-67 monitoring and alert operations

The server-side monitoring boundary is Sentry. The Next.js server and Node
worker should use separate projects. If the account cannot provide two
projects, configure both service DSNs to the same project; every event and span
still carries the low-cardinality `service=web|worker` dimension.

Runtime identity is fixed by code:

- environment: `APP_ENV`
- release: `DEPLOYMENT_COMMIT_SHA`
- service: `web` or `worker`

Development and test run with empty DSNs. Preview, staging, and production
fail at startup without monitoring configuration. Set `SENTRY_WEB_DSN`,
`SENTRY_WORKER_DSN`, and `SENTRY_TRACES_SAMPLE_RATE` in the deployment. The
sample rate is deliberately not defaulted.

## Privacy boundary

The SDK is server-only and uses `sendDefaultPii: false` plus explicit disabled
collection for users, cookies, headers, bodies, query parameters, database
values, local variables, source context, and generative-AI input/output.
Breadcrumbs are disabled. A final allowlist rebuilds error events and spans,
preserving only normalized operation/service identity, release/environment,
trace identifiers, safe status fields, generated request IDs, and bounded
error diagnostics. Error class names must come from the closed code-owned
allowlist; error codes are limited to a closed set of operational network
codes and bounded provider HTTP status codes. Those fields form a
stable operation/name/code fingerprint while messages, causes, and stack
content are replaced before capture. The same diagnostics are written to the
structured first-party error stream, never as a raw error object. Candidate names, email addresses,
filenames, resume text, prompts, quotes, object keys, raw SQL values, raw
provider responses, and arbitrary context must never be added to telemetry.

## Alert provisioning

`scripts/observability/sentry-alerts.mjs` renders current Sentry detector API
payloads without network access by default. It creates definitions for web
failure rate, P95 for all twelve normalized operations, and worker inference
token-budget warning/capped events. It never defines a queue-age detector.

The operator must provide thresholds; there are no production defaults:

- `SENTRY_ALERT_ERROR_RATE_THRESHOLD_PERCENT`
- `SENTRY_ALERT_WORKER_ERROR_COUNT_THRESHOLD`
- `SENTRY_ALERT_EVALUATION_WINDOW_SECONDS`
- `SENTRY_ALERT_MIN_EVENT_VOLUME`
- `SENTRY_ALERT_P95_THRESHOLDS_MS` (JSON object with every normalized operation)
- `SENTRY_ALERT_TOKEN_BUDGET_EVENT_THRESHOLD`
- `SENTRY_ALERT_WORKFLOW_IDS`
- `SENTRY_ALERT_OWNER`
- `SENTRY_ORG`, `SENTRY_WEB_PROJECT`, and optionally `SENTRY_WORKER_PROJECT`

Run the script without flags and review the JSON. `--apply` additionally
requires a narrowly scoped `SENTRY_AUTH_TOKEN`; it updates exact-name monitors
or creates them and refuses to apply without an owner and notification
workflow. Account-specific workflow actions/channels are configured outside
the repository, so no personal address or channel is committed.

Sentry's detector API currently represents one aggregate threshold per metric
monitor and cannot express `failure_rate above X AND request count at least Y`
in this payload. Keep notifications disabled until the configured minimum
event volume is enforced by the account's workflow capability or the on-call
team explicitly accepts that limitation. The value remains mandatory in the
rendered definition and description so it cannot disappear silently.

Provider monetary spend stays external under `COST_CONTROL_REFERENCE` and
`COST_CONTROL_OWNER`. The application signal is only the existing token
ledger's `tokens used / configured cap`, preserving `ok`, `warning`, and
`capped` states.

The warning ratio remains the existing `InferenceBudgetConfig.alertThresholdRatio`
input, and the budget period remains the ledger's caller-supplied `periodStart`.
The worker's `executeBudgetedInference` boundary now owns the complete metered
call: atomic reservation, provider execution, provider-usage settlement,
committed budget-state calculation, and telemetry publication. Its caller must
source the ratio, period and cap from approved external operations configuration;
AF-67 does not invent defaults. AF-102 will deliver durable jobs to this boundary
without changing its budget or telemetry semantics.

The web detector uses `failure_rate()` because normalized request-operation
spans provide a denominator. The current worker only serves a health endpoint
and runs no durable jobs, so there is no honest worker failure-rate denominator
before AF-102. Its unexpected failures use a separately configurable error
count detector for now; replace that with a job failure rate only after AF-102
publishes completed job volume.

## Pre-customer validation

Use only synthetic staging fixtures. First run the automated tests, which use
an in-memory telemetry adapter and deterministic fake span completion—never
sleeping—to verify error capture, sanitization, fixed operation names, and
budget states. Then provision temporary staging-only thresholds and verify:

1. trigger one controlled unexpected 500 with synthetic input and confirm the
   request ID matches while request/body/candidate data is absent;
2. run a synthetic operation repeatedly with the staging P95 threshold below
   its observed baseline, then restore the approved threshold;
3. report synthetic ledger snapshots on both sides of the configured warning
   ratio and at the cap, confirming warning and capped remain distinct;
4. verify the notification workflow resolves after the signal falls below its
   threshold and record the drill in the operations log.

Telemetry failure must also be tested by using the throwing in-memory adapter:
the HTTP response or worker outcome must remain unchanged.

## Queue-age boundary

Queue age is blocked on AF-102. Do not use the recruiter review list,
application creation time, or `evidence_extraction_runs` as a proxy. When
AF-102 lands, consume its vendor-neutral job timestamps to publish:

- `queue.age.oldest_ready = now - oldest ready enqueued_at`
- `queue.wait = started_at - enqueued_at`
- `job.duration = completed_at/failed_at - started_at`

Only then add the queue-age detector with an externally approved threshold.
