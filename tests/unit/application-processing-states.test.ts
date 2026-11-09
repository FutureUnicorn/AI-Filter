import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_ENTITY_TYPE,
  APPLICATION_EVIDENCE_STATES,
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_EXTRACTION_JOB_STATES,
  JOB_STATE_TO_EVIDENCE_STATE,
  buildApplicationReviewQueue,
  deriveApplicationEvidenceState,
  parseApplicationStateFilter
} from "../../packages/domain/src/index.ts";
import type {
  Application,
  EvidenceExtractionJobRef,
  EvidenceExtractionJobState
} from "../../packages/domain/src/index.ts";

// AF-45, completing the state set: the queue reports where every
// application is in processing, from AF-102's job table, instead of only
// whether an extraction run was ever recorded.

const roleId = "11111111-4111-4111-8111-111111111111";

function application(applicationId: string, sourceRowNumber: number): Application {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    applicationId,
    organizationId: "22222222-4222-4222-8222-222222222222",
    roleId,
    intakeId: "33333333-4333-4333-8333-333333333333",
    sourceRowNumber,
    candidateFullName: "Casey Rivera",
    candidateEmail: "casey@example.test",
    createdAt: "2026-08-29T12:00:00.000Z"
  };
}

function job(
  applicationId: string,
  state: EvidenceExtractionJobState,
  overrides: Partial<EvidenceExtractionJobRef> = {}
): EvidenceExtractionJobRef {
  return { applicationId, state, enqueueGeneration: 1, attemptCount: 0, maxAttempts: 3, ...overrides };
}

const run = (entityId: string) => ({
  entityType: APPLICATION_ENTITY_TYPE,
  entityId,
  createdAt: "2026-08-29T13:00:00.000Z"
});

test("every job state maps to exactly one queue state, and every queue state is reachable", () => {
  assert.deepEqual(
    EVIDENCE_EXTRACTION_JOB_STATES.map((state) => [state, deriveApplicationEvidenceState({ state }, 0)]),
    [
      ["ready", "queued"],
      ["running", "processing"],
      ["completed", "extracted"],
      ["failed", "extraction_failed"]
    ]
  );
  const reachable = new Set([
    ...Object.values(JOB_STATE_TO_EVIDENCE_STATE),
    deriveApplicationEvidenceState(undefined, 0),
    deriveApplicationEvidenceState(undefined, 1)
  ]);
  assert.deepEqual([...reachable].sort(), [...APPLICATION_EVIDENCE_STATES].sort());
});

test("without a job, a recorded run still means extracted and nothing means not queued", () => {
  assert.equal(deriveApplicationEvidenceState(undefined, 0), "pending_extraction");
  assert.equal(deriveApplicationEvidenceState(undefined, 2), "extracted");
});

test("the current job wins over an older run: a requeued application is being reprocessed", () => {
  // Showing this as "extracted" would present the previous run's results
  // as current while a new extraction is pending.
  const queue = buildApplicationReviewQueue(roleId, [application("a", 1)], [run("a")], [], [
    job("a", "ready", { enqueueGeneration: 2 })
  ]);
  assert.equal(queue.entries[0]?.evidenceState, "queued");
  assert.equal(queue.entries[0]?.extractionRunCount, 1);
  assert.equal(queue.entries[0]?.lastExtractionAt, "2026-08-29T13:00:00.000Z");
  assert.equal(queue.extractedCount, 0);
  assert.equal(queue.queuedCount, 1);
});

test("the newest enqueue generation decides, whatever order the jobs arrive in", () => {
  const older = job("a", "failed", { enqueueGeneration: 1, attemptCount: 3, failureCode: "provider_transient" });
  const newer = job("a", "running", { enqueueGeneration: 2, attemptCount: 1 });
  for (const jobs of [
    [older, newer],
    [newer, older]
  ]) {
    const queue = buildApplicationReviewQueue(roleId, [application("a", 1)], [], [], jobs);
    assert.equal(queue.entries[0]?.evidenceState, "processing");
    assert.deepEqual(queue.entries[0]?.job, { state: "running", attemptCount: 1, maxAttempts: 3 });
  }
});

test("a retrying job is queued and carries its attempt count and last failure code", () => {
  const queue = buildApplicationReviewQueue(roleId, [application("a", 1)], [], [], [
    job("a", "ready", { attemptCount: 1, failureCode: "provider_transient" })
  ]);
  assert.equal(queue.entries[0]?.evidenceState, "queued");
  assert.deepEqual(queue.entries[0]?.job, {
    state: "ready",
    attemptCount: 1,
    maxAttempts: 3,
    failureCode: "provider_transient"
  });
});

test("the job summary exposes delivery state only, not the generation or anything else passed in", () => {
  const leaky = { ...job("a", "running"), leaseOwner: "worker-7", sourceIntakeId: "x" } as EvidenceExtractionJobRef;
  const entry = buildApplicationReviewQueue(roleId, [application("a", 1)], [], [], [leaky]).entries[0];
  assert.deepEqual(Object.keys(entry?.job ?? {}).sort(), ["attemptCount", "maxAttempts", "state"]);
});

test("a job for an application outside this role's list is ignored entirely", () => {
  const queue = buildApplicationReviewQueue(roleId, [application("a", 1)], [], [], [job("not-in-role", "failed")]);
  assert.equal(queue.totalCount, 1);
  assert.equal(queue.extractionFailedCount, 0);
  assert.equal(queue.entries[0]?.evidenceState, "pending_extraction");
  assert.equal(queue.entries[0]?.job, undefined);
});

test("the five counts partition the total for a mixed role", () => {
  const applications = ["a", "b", "c", "d", "e", "f"].map((id, index) => application(id, index + 1));
  const queue = buildApplicationReviewQueue(roleId, applications, [run("f")], [], [
    job("b", "ready"),
    job("c", "running"),
    job("d", "failed"),
    job("e", "completed")
  ]);
  assert.deepEqual(
    queue.entries.map((entry) => entry.evidenceState),
    ["pending_extraction", "queued", "processing", "extraction_failed", "extracted", "extracted"]
  );
  assert.deepEqual(
    [queue.pendingExtractionCount, queue.queuedCount, queue.processingCount, queue.extractionFailedCount, queue.extractedCount],
    [1, 1, 1, 1, 2]
  );
  assert.equal(
    queue.pendingExtractionCount + queue.queuedCount + queue.processingCount + queue.extractionFailedCount + queue.extractedCount,
    queue.totalCount
  );
});

test("the new states are filterable, and filtering keeps import order and whole-role counts", () => {
  const applications = ["a", "b", "c"].map((id, index) => application(id, index + 1));
  const jobs = [job("a", "failed"), job("b", "ready"), job("c", "failed")];
  const parsed = parseApplicationStateFilter(["extraction_failed"]);
  assert.ok(parsed.ok);
  const queue = buildApplicationReviewQueue(roleId, applications, [], parsed.states, jobs);
  assert.deepEqual(
    queue.entries.map((entry) => entry.application.applicationId),
    ["a", "c"]
  );
  assert.equal(queue.totalCount, 3);
  assert.equal(queue.queuedCount, 1);
});
