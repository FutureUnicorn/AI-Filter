import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceExtractionFailureOutcomes,
  deriveEvidenceExtractionJobTiming,
  type EvidenceExtractionJob
} from "../../packages/domain/src/index.ts";

function job(overrides: Partial<EvidenceExtractionJob> = {}): EvidenceExtractionJob {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    roleId: "33333333-3333-4333-8333-333333333333",
    applicationId: "44444444-4444-4444-8444-444444444444",
    sourceIntakeId: "55555555-5555-4555-8555-555555555555",
    rubricId: "66666666-6666-4666-8666-666666666666",
    workflowVersion: "1.0.0",
    state: "completed",
    enqueuedAt: "2026-09-22T10:00:00.000Z",
    availableAt: "2026-09-22T10:00:00.000Z",
    startedAt: "2026-09-22T10:00:02.000Z",
    completedAt: "2026-09-22T10:00:07.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    updatedAt: "2026-09-22T10:00:07.000Z",
    ...overrides
  };
}

test("queue wait and job duration follow the vendor-neutral AF-102 contract", () => {
  assert.deepEqual(deriveEvidenceExtractionJobTiming(job()), {
    queueWaitMs: 2_000,
    durationMs: 5_000
  });
});

test("unresolved jobs omit durations and clock skew cannot create negative telemetry", () => {
  assert.deepEqual(
    deriveEvidenceExtractionJobTiming(job({ state: "ready", startedAt: undefined, completedAt: undefined })),
    {}
  );
  assert.deepEqual(
    deriveEvidenceExtractionJobTiming(
      job({
        startedAt: "2026-09-22T09:59:59.000Z",
        completedAt: "2026-09-22T09:59:58.000Z"
      })
    ),
    { queueWaitMs: 0, durationMs: 0 }
  );
});

test("terminal queue failures produce one safe failed outcome per rubric criterion", () => {
  const outcomes = buildEvidenceExtractionFailureOutcomes(
    {
      organizationId: "22222222-2222-4222-8222-222222222222",
      applicationId: "44444444-4444-4444-8444-444444444444"
    },
    ["criterion_1", "criterion_2"],
    "unexpected_error"
  );
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) =>
    outcome.kind === "failed" &&
    outcome.errorCode === "unexpected_error" &&
    outcome.message === "Evidence extraction could not be completed." &&
    outcome.retryable === false
  ));
  assert.throws(
    () => buildEvidenceExtractionFailureOutcomes(
      {
        organizationId: "22222222-2222-4222-8222-222222222222",
        applicationId: "44444444-4444-4444-8444-444444444444"
      },
      ["criterion_1"],
      "candidate@example.test"
    ),
    /bounded machine-readable code/u
  );
});
