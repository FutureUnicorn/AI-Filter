import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-104. scripts/observability/sentry-alerts.mjs provisions warning and
// capped monitors querying monitor.operation:inference.token_budget. When
// those were written, the only emitter sat inside executeBudgetedInference,
// which had no production caller: the worker entry started a health server
// and nothing else. So applying the alert definitions created two monitors
// that could not fire, and a monitor that has never fired is
// indistinguishable from a healthy one. It reads as coverage that does not
// exist.
//
// AF-102 supplied the caller. This pins that it stays supplied. A unit test
// cannot: calling recordInferenceBudgetTelemetry directly proves the
// function works, not that anything deployed reaches it, which is exactly
// the gap AF-104 described. So these assertions follow the chain from the
// worker entry point to the emitter through call sites rather than through
// the identifier appearing somewhere in the file.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

test("the provisioned token-budget monitors name an operation the code emits", () => {
  const alerts = source("scripts/observability/sentry-alerts.mjs");
  const observability = source("apps/worker/src/observability.ts");
  assert.match(
    alerts,
    /inference\.token_budget/u,
    "the monitor definitions must name the operation they watch"
  );
  assert.match(
    observability,
    /inference\.token_budget/u,
    "the emitter must publish under the operation the monitors query, or they watch nothing"
  );
});

test("a deployed path reaches the token-budget emitter", () => {
  // Entry point -> extraction loop -> budgeted inference -> emitter. Each
  // hop is matched as a call or an import, not as a bare mention, because
  // a re-export would satisfy the identifier while leaving it unreachable.
  const entry = source("apps/worker/src/index.ts");
  assert.match(
    entry,
    /from "\.\/extraction\.ts"/u,
    "the worker entry must pull in the extraction loop"
  );
  assert.match(
    entry,
    /runEvidenceExtractionWorker/u,
    "the entry point must reference the loop that claims and processes jobs"
  );

  const extraction = source("apps/worker/src/extraction.ts");
  assert.match(
    extraction,
    /executeBudgetedInference\s*\(/u,
    "the extraction path must call executeBudgetedInference, not merely import it"
  );

  const inference = source("apps/worker/src/inference.ts");
  assert.match(
    inference,
    /await recordInferenceBudgetTelemetry\s*\(/u,
    "executeBudgetedInference must emit the budget telemetry the monitors query"
  );
});

test("the emitter is reached on both the settled and the capped path", () => {
  // The capped path is the one the "capped" monitor exists for. If only
  // the success path emitted, that monitor would stay silent through
  // exactly the event it was provisioned to catch.
  const inference = source("apps/worker/src/inference.ts");
  const emissions = inference.split("recordInferenceBudgetTelemetry(").length - 1;
  assert.ok(
    emissions >= 2,
    `expected the settled and capped paths to emit, found ${emissions} call site(s)`
  );
});

// ---- AF-67 queue age, same failure mode ----
//
// The queue-age detector has the same exposure as the token-budget ones:
// it queries an operation that only exists if something deployed emits it.
// It is worse here, because the signal is published on the heartbeat
// precisely so a STALLED worker still reports its backlog. If the publish
// call is dropped, the detector goes quiet exactly when the queue is
// growing, and a quiet detector is indistinguishable from an empty queue.
//
// Removing `.then(publishQueueTelemetry)` from the heartbeat timer passes
// every behavioural test in the suite. These assertions are what notice.

test("the queue-age monitor's operation is emitted by the worker", () => {
  const alerts = source("scripts/observability/sentry-alerts.mjs");
  const observability = source("apps/worker/src/observability.ts");
  assert.match(alerts, /monitor\.operation:evidence_extraction\.queue/u);
  assert.match(
    observability,
    /"monitor\.operation": "evidence_extraction\.queue"/u,
    "the emitter must publish under the operation the detector queries"
  );
});

test("the queue snapshot is published from the heartbeat, not from the dequeue path", () => {
  const extraction = source("apps/worker/src/extraction.ts");
  assert.match(
    extraction,
    /getEvidenceExtractionQueueMonitoringSnapshot\s*\(/u,
    "the worker must read AF-102's queue snapshot rather than deriving a proxy"
  );
  assert.match(
    extraction,
    /recordEvidenceExtractionQueueTelemetry\s*\(/u,
    "reading the snapshot without publishing it leaves the detector silent"
  );
  // The binding that matters. A stalled worker claims nothing, so a
  // publish hung off the claim loop would report nothing exactly when the
  // backlog is growing.
  assert.match(
    extraction,
    /writeHeartbeat\(\)\s*\r?\n?\s*\.then\(publishQueueTelemetry\)/u,
    "the queue publish must hang off the heartbeat tick, which fires whether or not work is claimed"
  );
});

test("the queue telemetry carries no identifier", () => {
  // Counts and durations only. A backlog signal that carried an
  // organization or application id would put tenant data in a stream that
  // retention and deletion cannot reach.
  const observability = source("apps/worker/src/observability.ts");
  const start = observability.indexOf("export interface EvidenceExtractionQueueTelemetry");
  const end = observability.indexOf("export async function recordEvidenceExtractionQueueTelemetry");
  assert.ok(start >= 0 && end > start, "the queue telemetry contract must be locatable");
  const contract = observability.slice(start, end);
  assert.doesNotMatch(
    contract,
    /organizationId|applicationId|candidate|jobId|intakeId|documentId/iu,
    "the queue signal must stay counts and durations"
  );
});
