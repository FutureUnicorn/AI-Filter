import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STUCK_JOB_THRESHOLDS,
  authorizeJobAdministration,
  buildDeadLetterOutcome,
  identifyStuckJobs
} from "../../packages/domain/src/index.ts";
import type {
  JobAdministrationRequest,
  JobObservation,
  StuckJob
} from "../../packages/domain/src/index.ts";

// AF-65: "Admin view to retry or dead-letter stuck import/extraction
// jobs without manually editing underlying candidate data."

const ORG = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-29T12:00:00.000Z");

function observation(overrides: Partial<JobObservation> = {}): JobObservation {
  return {
    jobId: "job-1",
    kind: "extraction",
    organizationId: ORG,
    terminal: false,
    attempts: 0,
    waitingSince: "2026-08-29T10:00:00.000Z",
    ...overrides
  };
}

function stuck(overrides: Partial<StuckJob> = {}): StuckJob {
  return { ...observation(), stuckForMs: 7_200_000, retryable: true, ...overrides };
}

function request(overrides: Partial<JobAdministrationRequest> = {}): JobAdministrationRequest {
  return {
    jobId: "job-1",
    action: "retry",
    reason: "provider returned 503 for two hours; queue has drained since",
    operatorUserId: OPERATOR,
    ...overrides
  };
}

test("a terminal job is never stuck, however old", () => {
  // Age is not the signal; being unfinished is. A completed job from last
  // month must not appear in a triage list.
  const jobs = identifyStuckJobs(
    [observation({ terminal: true, waitingSince: "2020-01-01T00:00:00.000Z" })],
    NOW
  );
  assert.deepEqual(jobs, []);
});

test("a job that is merely slow is not yet stuck", () => {
  // Flagging a slow job invites a retry that duplicates work still in
  // flight, and the operator cannot tell the two apart from outside.
  const jobs = identifyStuckJobs([observation({ waitingSince: "2026-08-29T11:30:00.000Z" })], NOW);
  assert.deepEqual(jobs, [], "30 minutes is under the one-hour extraction threshold");
});

test("import and extraction have different thresholds", () => {
  // A 45-minute wait is stuck for an import and not yet for an extraction.
  const waitingSince = "2026-08-29T11:15:00.000Z";
  assert.equal(identifyStuckJobs([observation({ kind: "import", waitingSince })], NOW).length, 1);
  assert.equal(identifyStuckJobs([observation({ kind: "extraction", waitingSince })], NOW).length, 0);
});

test("the longest-waiting job comes first, because the list is a triage queue", () => {
  const jobs = identifyStuckJobs(
    [
      observation({ jobId: "recent", waitingSince: "2026-08-29T10:30:00.000Z" }),
      observation({ jobId: "oldest", waitingSince: "2026-08-29T06:00:00.000Z" })
    ],
    NOW
  );
  assert.deepEqual(jobs.map((job) => job.jobId), ["oldest", "recent"]);
});

test("a job at its attempt ceiling is reported as no longer retryable", () => {
  const [job] = identifyStuckJobs([observation({ attempts: DEFAULT_STUCK_JOB_THRESHOLDS.maxAttempts })], NOW);
  assert.equal(job?.retryable, false);
});

test("no support access means no administration at all", () => {
  // An admin action on a tenant's data is a look at that data plus a
  // write. AF-66's decision is passed in rather than re-derived here.
  const decision = authorizeJobAdministration(stuck(), request(), false);
  assert.equal(decision.allowed ? undefined : decision.refusal, "not_authorized");
});

test("an unexplained action is refused, for retry and dead-letter alike", () => {
  // An unexplained retry is indistinguishable from an accident, and
  // dead-lettering without a reason discards a candidate silently.
  for (const action of ["retry", "dead_letter"] as const) {
    for (const reason of ["", "   ", "\t\n"]) {
      const decision = authorizeJobAdministration(stuck(), request({ action, reason }), true);
      assert.equal(decision.allowed ? undefined : decision.refusal, "reason_required");
    }
  }
});

test("retrying is refused once attempts are exhausted", () => {
  // Unbounded retry on a permanently broken document burns the inference
  // budget AF-41 protects, and never terminates.
  const decision = authorizeJobAdministration(
    stuck({ attempts: DEFAULT_STUCK_JOB_THRESHOLDS.maxAttempts, retryable: false }),
    request({ action: "retry" }),
    true
  );
  assert.equal(decision.allowed ? undefined : decision.refusal, "retries_exhausted");
});

test("dead-lettering stays available even before retries are exhausted", () => {
  // Otherwise an operator has no way to stop a document that is provably
  // never going to parse.
  const decision = authorizeJobAdministration(stuck({ attempts: 0 }), request({ action: "dead_letter" }), true);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed ? decision.action : undefined, "dead_letter");
});

test("dead-lettering is available precisely when retrying is not", () => {
  const exhausted = stuck({ attempts: DEFAULT_STUCK_JOB_THRESHOLDS.maxAttempts, retryable: false });
  assert.equal(authorizeJobAdministration(exhausted, request({ action: "retry" }), true).allowed, false);
  assert.equal(authorizeJobAdministration(exhausted, request({ action: "dead_letter" }), true).allowed, true);
});

test("a successful retry reports the attempt number it will become", () => {
  const decision = authorizeJobAdministration(stuck({ attempts: 1 }), request({ action: "retry" }), true);
  assert.equal(decision.allowed ? decision.attempt : undefined, 2);
});

test("administering a job that is not stuck, or already terminal, is refused", () => {
  assert.equal(
    authorizeJobAdministration(undefined, request(), true).allowed ? undefined : "job_not_stuck",
    "job_not_stuck"
  );
  const decision = authorizeJobAdministration(stuck({ terminal: true }), request(), true);
  assert.equal(decision.allowed ? undefined : decision.refusal, "job_already_terminal");
});

test("a dead-letter outcome is not retryable, or the sweep would pick it up again", () => {
  const outcome = buildDeadLetterOutcome("python_production", "document is password-protected");
  assert.equal(outcome.kind, "extraction_error");
  if (outcome.kind === "extraction_error") {
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.errorCode, "dead_lettered_by_operator");
    assert.equal(outcome.message, "document is password-protected");
  }
});

test("a dead-letter outcome requires a reason", () => {
  assert.throws(() => buildDeadLetterOutcome("c", "   "), /non-whitespace reason/);
});

test("the administration request has nowhere to put candidate data", () => {
  // The requirement is the clause after "without". This is a property of
  // the type, not a rule someone has to remember: the only free text is
  // the reason, and the only identifiers are a job and an operator.
  const keys = Object.keys(request()).sort();
  assert.deepEqual(keys, ["action", "jobId", "operatorUserId", "reason"]);
});
