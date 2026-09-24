import assert from "node:assert/strict";
import test from "node:test";

import {
  DEAD_LETTER_EXPLANATION,
  DEFAULT_STUCK_JOB_THRESHOLDS,
  authorizeJobAdministration,
  buildDeadLetterOutcome,
  buildEvidenceCard,
  identifyStuckJobs
} from "../../packages/domain/src/index.ts";
import type {
  JobAdministrationAccess,
  JobAdministrationRequest,
  JobObservation,
  StuckJob,
  SupportAccessGrant
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

// REV-001: administration is authorised by a real AF-66 grant, for this
// tenant and this operator, not by a boolean saying some check passed.
function grant(overrides: Partial<SupportAccessGrant> = {}): SupportAccessGrant {
  return {
    grantId: "grant-1",
    organizationId: ORG,
    operatorUserId: OPERATOR,
    reason: "customer reported a stuck import",
    grantedByUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    grantedAt: "2026-08-29T11:00:00.000Z",
    expiresAt: "2026-08-29T13:00:00.000Z",
    ...overrides
  };
}

const LIVE: JobAdministrationAccess = { grant: grant(), now: NOW };
const NO_GRANT: JobAdministrationAccess = { grant: undefined, now: NOW };

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
  const decision = authorizeJobAdministration(stuck(), request(), NO_GRANT);
  assert.equal(decision.allowed ? undefined : decision.refusal, "not_authorized");
});

// ---- REV-001: the grant must cover THIS job ----

test("a request naming a different job than the one decided on is refused", () => {
  // Pradeep's reproduction: stuck job A, a request for job B. It used to be
  // allowed, and a dead-letter cannot be undone.
  const decision = authorizeJobAdministration(stuck(), request({ jobId: "job-B", action: "dead_letter" }), LIVE);
  assert.equal(decision.allowed ? undefined : decision.refusal, "job_mismatch");
});

test("a grant for one tenant cannot administer another tenant's job", () => {
  // The cross-tenant write AF-66 exists to prevent: the grant is live and
  // the operator matches, but it was issued for a different organization.
  const otherTenant = { grant: grant({ organizationId: "22222222-2222-4222-8222-222222222222" }), now: NOW };
  const decision = authorizeJobAdministration(stuck(), request({ action: "dead_letter" }), otherTenant);
  assert.equal(decision.allowed ? undefined : decision.refusal, "not_authorized");
  assert.equal(decision.allowed ? undefined : decision.supportAccessDenial, "grant_for_other_organization");
});

test("another operator's grant does not authorise this operator", () => {
  const someoneElse = { grant: grant({ operatorUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), now: NOW };
  const decision = authorizeJobAdministration(stuck(), request(), someoneElse);
  assert.equal(decision.allowed ? undefined : decision.supportAccessDenial, "grant_for_other_operator");
});

test("an expired or revoked grant authorises nothing", () => {
  const expired = { grant: grant({ expiresAt: "2026-08-29T11:59:59.999Z" }), now: NOW };
  const revoked = { grant: grant({ revokedAt: "2026-08-29T11:30:00.000Z" }), now: NOW };
  assert.equal(authorizeJobAdministration(stuck(), request(), expired).allowed, false);
  assert.equal(authorizeJobAdministration(stuck(), request(), revoked).allowed, false);
});

test("an allowed administration names the grant that permitted it", () => {
  // So the admin_action audit event can say which grant authorised the write.
  const retry = authorizeJobAdministration(stuck({ attempts: 1 }), request({ action: "retry" }), LIVE);
  const deadLetter = authorizeJobAdministration(stuck(), request({ action: "dead_letter" }), LIVE);
  assert.equal(retry.allowed ? retry.grantId : undefined, "grant-1");
  assert.equal(deadLetter.allowed ? deadLetter.grantId : undefined, "grant-1");
});

test("an unexplained action is refused, for retry and dead-letter alike", () => {
  // An unexplained retry is indistinguishable from an accident, and
  // dead-lettering without a reason discards a candidate silently.
  for (const action of ["retry", "dead_letter"] as const) {
    for (const reason of ["", "   ", "\t\n"]) {
      const decision = authorizeJobAdministration(stuck(), request({ action, reason }), LIVE);
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
    LIVE
  );
  assert.equal(decision.allowed ? undefined : decision.refusal, "retries_exhausted");
});

test("dead-lettering stays available even before retries are exhausted", () => {
  // Otherwise an operator has no way to stop a document that is provably
  // never going to parse.
  const decision = authorizeJobAdministration(stuck({ attempts: 0 }), request({ action: "dead_letter" }), LIVE);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed ? decision.action : undefined, "dead_letter");
});

test("dead-lettering is available precisely when retrying is not", () => {
  const exhausted = stuck({ attempts: DEFAULT_STUCK_JOB_THRESHOLDS.maxAttempts, retryable: false });
  assert.equal(authorizeJobAdministration(exhausted, request({ action: "retry" }), LIVE).allowed, false);
  assert.equal(authorizeJobAdministration(exhausted, request({ action: "dead_letter" }), LIVE).allowed, true);
});

test("a successful retry reports the attempt number it will become", () => {
  const decision = authorizeJobAdministration(stuck({ attempts: 1 }), request({ action: "retry" }), LIVE);
  assert.equal(decision.allowed ? decision.attempt : undefined, 2);
});

test("administering a job that is not stuck, or already terminal, is refused", () => {
  assert.equal(
    authorizeJobAdministration(undefined, request(), LIVE).allowed ? undefined : "job_not_stuck",
    "job_not_stuck"
  );
  const decision = authorizeJobAdministration(stuck({ terminal: true }), request(), LIVE);
  assert.equal(decision.allowed ? undefined : decision.refusal, "job_already_terminal");
});

test("a dead-letter outcome is not retryable, or the sweep would pick it up again", () => {
  const outcome = buildDeadLetterOutcome("python_production");
  if (outcome.kind !== "failed") {
    assert.fail(`a dead-letter outcome must be kind "failed", got "${outcome.kind}"`);
  }
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.errorCode, "dead_lettered_by_operator");
  assert.equal(outcome.message, DEAD_LETTER_EXPLANATION);
});

test("a dead-letter outcome is an operator's terminal failed, never a pipeline extraction_error", () => {
  // FailedEvidence and ExtractionErrorEvidence share every field, so the
  // compiler accepts either. evidence_outcomes is append-only, so a
  // dead-letter written as extraction_error would permanently read as a
  // system break rather than an operator decision.
  const outcome = buildDeadLetterOutcome("python_production");
  assert.equal(outcome.kind, "failed");
  assert.notEqual(outcome.kind, "extraction_error");
});

// ---- REV-003: the operator's words never reach the candidate ----
//
// The reason requirement did not go away: authorizeJobAdministration still
// refuses a blank one (reason_required, tested above). What went away is the
// path by which that text reached an append-only evidence row and the
// candidate's card.

test("an operator's reason never reaches the append-only outcome or the candidate's card", () => {
  // AF-66's own example of what an operator naturally writes, plus an email
  // address. Redaction would not save this: a name is not a pattern.
  const reason = "Looking at Jane Doe's stuck upload, jane.doe@example.test says it never finished";
  const decision = authorizeJobAdministration(stuck(), request({ action: "dead_letter", reason }), LIVE);
  assert.equal(decision.allowed, true);

  const outcome = buildDeadLetterOutcome("python_production");
  const card = buildEvidenceCard(outcome, "2026-08-29T12:00:00.000Z");
  assert.equal(card.explanation, DEAD_LETTER_EXPLANATION);
  for (const fragment of ["Jane Doe", "jane.doe@example.test", "stuck upload"]) {
    assert.ok(!JSON.stringify(outcome).includes(fragment), `the stored outcome must not carry "${fragment}"`);
    assert.ok(!JSON.stringify(card).includes(fragment), `the evidence card must not show "${fragment}"`);
  }
});

test("the dead-letter outcome ignores anything passed after the criterion", () => {
  // The fix is the absence of a path, so pin the absence behaviourally.
  // Function.length would not do: a defaulted second parameter does not
  // count towards it, so `(criterionId, note = "")` would pass that check
  // while reopening the path. Forcing a second argument through catches a
  // defaulted parameter and a rest parameter alike.
  const withText = (buildDeadLetterOutcome as (...args: unknown[]) => ReturnType<typeof buildDeadLetterOutcome>)(
    "python_production",
    "Looking at Jane Doe's stuck upload"
  );
  assert.ok(!JSON.stringify(withText).includes("Jane Doe"), "a second argument must never reach the outcome");
  assert.equal(buildEvidenceCard(withText, "2026-08-29T12:00:00.000Z").explanation, DEAD_LETTER_EXPLANATION);
});

test("the administration request has nowhere to put candidate data", () => {
  // The requirement is the clause after "without". This is a property of
  // the type, not a rule someone has to remember: the only free text is
  // the reason, and the only identifiers are a job and an operator.
  const keys = Object.keys(request()).sort();
  assert.deepEqual(keys, ["action", "jobId", "operatorUserId", "reason"]);
});
