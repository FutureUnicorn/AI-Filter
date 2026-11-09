import assert from "node:assert/strict";
import test from "node:test";

import { randomUUID } from "node:crypto";

import { EVIDENCE_EXTRACTION_WORKFLOW_VERSION } from "../../packages/contracts/src/index.ts";
import {
  assertApplicantOrderingPreserved,
  assertApplicationQueueTenantIsolation,
  claimEvidenceExtractionJob,
  completeEvidenceExtractionJob,
  dropProbeSchema,
  enqueueEvidenceExtractionJob,
  listCurrentEvidenceExtractionJobsForApplications,
  provisionEvidenceExtractionQueueProbeSchema,
  retryOrFailEvidenceExtractionJob
} from "../../packages/db/src/index.ts";
import { applicationReviewQueueSchema } from "../../packages/contracts/src/index.ts";
import { CONTRACT_SCHEMA_VERSION, buildApplicationReviewQueue } from "../../packages/domain/src/index.ts";
import type { Application } from "../../packages/domain/src/index.ts";

// AF-45's review queue is the first view that lists real candidate
// records, so "tenant-scoped" in the ticket title is the security
// property, not a description. This exercises it against a real
// database rather than asserting it from the shape of the code.

test("the application review queue cannot be pointed at another tenant's role", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises the review queue's tenant scoping against real Postgres"
    );
  }
  await assertApplicationQueueTenantIsolation(databaseUrl);
});

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

test("what buildApplicationReviewQueue produces satisfies the published contract", () => {
  const queue = buildApplicationReviewQueue(
    roleId,
    [application("44444444-4444-4444-8444-444444444444", 1), application("55555555-5555-4555-8555-555555555555", 2)],
    [
      {
        entityType: "application",
        entityId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-08-29T13:00:00.000Z"
      }
    ]
  );
  const parsed = applicationReviewQueueSchema.safeParse(queue);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("counts that do not partition the total are rejected, not passed through to a UI", () => {
  const queue = buildApplicationReviewQueue(roleId, [application("44444444-4444-4444-8444-444444444444", 1)], []);
  const lying = { ...queue, extractedCount: 1 };
  const parsed = applicationReviewQueueSchema.safeParse(lying);
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues.map((issue) => issue.message).join(" ") ?? "",
    /must sum to totalCount/
  );
});

test("a shownCount that disagrees with the entries it shipped is rejected", () => {
  const queue = buildApplicationReviewQueue(roleId, [application("44444444-4444-4444-8444-444444444444", 1)], []);
  const truncated = { ...queue, entries: [] };
  const parsed = applicationReviewQueueSchema.safeParse(truncated);
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues.map((issue) => issue.message).join(" ") ?? "",
    /shownCount must match the number of entries/
  );
});

test("an unfiltered queue that hides applications it counted is rejected", () => {
  // AF-47: with no filter applied there is nothing that could legitimately
  // shrink the view, so shownCount < totalCount means entries were lost
  // somewhere between the database and the response.
  const queue = buildApplicationReviewQueue(roleId, [
    application("44444444-4444-4444-8444-444444444444", 1),
    application("55555555-5555-4555-8555-555555555555", 2)
  ], []);
  const lossy = { ...queue, shownCount: 1, entries: queue.entries.slice(0, 1) };
  const parsed = applicationReviewQueueSchema.safeParse(lossy);
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues.map((issue) => issue.message).join(" ") ?? "",
    /unfiltered queue must show every application it counted/
  );
});

test("an entry that does not match the applied filter is rejected", () => {
  // The filter has to actually be what was applied. A response claiming
  // appliedStates: ["extracted"] while shipping a pending application is
  // mislabelling its own contents.
  const queue = buildApplicationReviewQueue(roleId, [application("44444444-4444-4444-8444-444444444444", 1)], []);
  const mislabelled = { ...queue, appliedStates: ["extracted"], shownCount: 1 };
  const parsed = applicationReviewQueueSchema.safeParse(mislabelled);
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues.map((issue) => issue.message).join(" ") ?? "",
    /must match one of the applied state filters/
  );
});

test("a filtered queue satisfies the contract", () => {
  const queue = buildApplicationReviewQueue(
    roleId,
    [application("44444444-4444-4444-8444-444444444444", 1), application("55555555-5555-4555-8555-555555555555", 2)],
    [
      {
        entityType: "application",
        entityId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-08-29T13:00:00.000Z"
      }
    ],
    ["extracted"]
  );
  assert.equal(queue.shownCount, 1);
  assert.equal(queue.totalCount, 2);
  const parsed = applicationReviewQueueSchema.safeParse(queue);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("an unknown evidence state is rejected rather than rendered as an empty cell", () => {
  const queue = buildApplicationReviewQueue(roleId, [application("44444444-4444-4444-8444-444444444444", 1)], []);
  const firstEntry = queue.entries[0];
  assert.ok(firstEntry !== undefined);
  const invented = {
    ...queue,
    entries: [{ ...firstEntry, evidenceState: "reviewed" }]
  };
  assert.equal(applicationReviewQueueSchema.safeParse(invented).success, false);
});

test("two imports sharing a created_at keep the employer's original order in the database", async () => {
  // AF-46. The pure comparator is covered in tests/unit; this is the
  // half that only a real database can answer -- that the SQL ORDER BY
  // agrees with it, on the fixture where a weaker one silently differs.
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises queue ordering against real Postgres"
    );
  }
  await assertApplicantOrderingPreserved(databaseUrl);
});

// ---- AF-45: the complete processing-state set ----

function requireDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises the queue's job states against real Postgres");
  }
  return databaseUrl;
}

const queuedEntry = () =>
  buildApplicationReviewQueue(roleId, [application("44444444-4444-4444-8444-444444444444", 1)], [], [], [
    {
      applicationId: "44444444-4444-4444-8444-444444444444",
      state: "ready",
      enqueueGeneration: 1,
      attemptCount: 1,
      maxAttempts: 3,
      failureCode: "provider_transient"
    }
  ]);

test("a queue with job-backed states satisfies the published contract", () => {
  const parsed = applicationReviewQueueSchema.safeParse(queuedEntry());
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("an evidence state that disagrees with its own job is rejected", () => {
  const queue = queuedEntry();
  const firstEntry = queue.entries[0];
  assert.ok(firstEntry !== undefined);
  const contradictory = { ...queue, entries: [{ ...firstEntry, evidenceState: "extracted" }] };
  assert.match(
    applicationReviewQueueSchema.safeParse(contradictory).error?.issues.map((issue) => issue.message).join(" ") ?? "",
    /must match the current job's state/
  );
});

test("a job summary with impossible attempts or a free-text failure code is rejected", () => {
  const queue = queuedEntry();
  const firstEntry = queue.entries[0];
  assert.ok(firstEntry?.job !== undefined);
  for (const job of [
    { ...firstEntry.job, attemptCount: 4 },
    { ...firstEntry.job, failureCode: "Provider said: rate limited for jordan@example.com" },
    { ...firstEntry.job, leaseOwner: "worker-7" }
  ]) {
    assert.equal(
      applicationReviewQueueSchema.safeParse({ ...queue, entries: [{ ...firstEntry, job }] }).success,
      false,
      JSON.stringify(job)
    );
  }
});

test("the current-job read follows a real job through every lifecycle state and stays tenant-scoped", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const read = async (organizationId = probe.organizationId) =>
    listCurrentEvidenceExtractionJobsForApplications(databaseUrl, probe.schema, organizationId, [probe.applicationId]);
  const stateOf = async () => {
    const jobs = await read();
    assert.equal(jobs.length, 1, "one current job per application");
    const queue = buildApplicationReviewQueue(
      probe.roleId,
      [{ ...application(probe.applicationId, 1), organizationId: probe.organizationId, roleId: probe.roleId }],
      [],
      [],
      jobs
    );
    assert.ok(applicationReviewQueueSchema.safeParse(queue).success);
    return { state: queue.entries[0]?.evidenceState, job: queue.entries[0]?.job };
  };

  assert.deepEqual(await read(), [], "nothing enqueued yet");

  const input = {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
    maxAttempts: 2
  } as const;
  const enqueued = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, input);
  assert.equal(enqueued.outcome, "enqueued");
  assert.deepEqual(await stateOf(), { state: "queued", job: { state: "ready", attemptCount: 0, maxAttempts: 2 } });

  // The IDOR half: the application id is real, the organization is not its own.
  assert.deepEqual(await read(randomUUID()), [], "another organization must not see this application's job");

  const base = Date.now() + 1_000;
  const firstClaim = (
    await claimEvidenceExtractionJob(databaseUrl, probe.schema, { workerId: "worker-a", leaseDurationMs: 10_000, now: new Date(base) })
  ).job;
  assert.ok(firstClaim !== undefined);
  assert.equal((await stateOf()).state, "processing");

  assert.equal(
    await retryOrFailEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      jobId: firstClaim.jobId,
      workerId: "worker-a",
      attemptCount: firstClaim.attemptCount,
      failureCode: "provider_transient",
      retryable: true,
      availableAt: new Date(base + 2_000),
      now: new Date(base + 1_000)
    }),
    "retrying"
  );
  assert.deepEqual(await stateOf(), {
    state: "queued",
    job: { state: "ready", attemptCount: 1, maxAttempts: 2, failureCode: "provider_transient" }
  });

  const secondClaim = (
    await claimEvidenceExtractionJob(databaseUrl, probe.schema, { workerId: "worker-b", leaseDurationMs: 10_000, now: new Date(base + 2_000) })
  ).job;
  assert.ok(secondClaim !== undefined);
  assert.equal(
    await retryOrFailEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      jobId: secondClaim.jobId,
      workerId: "worker-b",
      attemptCount: secondClaim.attemptCount,
      failureCode: "provider_transient",
      retryable: true,
      availableAt: new Date(base + 4_000),
      now: new Date(base + 3_000)
    }),
    "failed"
  );
  assert.deepEqual(await stateOf(), {
    state: "extraction_failed",
    job: { state: "failed", attemptCount: 2, maxAttempts: 2, failureCode: "provider_transient" }
  });

  // An operator requeue allocates a new generation; the read must follow it
  // rather than keep reporting the failure it replaced.
  const requeued = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, { ...input, now: new Date(base + 5_000) });
  assert.equal(requeued.outcome, "requeued");
  assert.equal((await stateOf()).state, "queued");

  const finalClaim = (
    await claimEvidenceExtractionJob(databaseUrl, probe.schema, { workerId: "worker-c", leaseDurationMs: 10_000, now: new Date(base + 6_000) })
  ).job;
  assert.ok(finalClaim !== undefined);
  assert.equal(
    await completeEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      jobId: finalClaim.jobId,
      workerId: "worker-c",
      attemptCount: finalClaim.attemptCount,
      outcomes: [],
      now: new Date(base + 7_000)
    }),
    "completed"
  );
  assert.deepEqual(await stateOf(), { state: "extracted", job: { state: "completed", attemptCount: 1, maxAttempts: 2 } });
});

// ---- AF-47: review filters in the published contract ----

const reviewQueue = (filters: readonly ("unreviewed" | "incomplete" | "contradiction" | "error")[] = []) =>
  buildApplicationReviewQueue(
    roleId,
    [application("44444444-4444-4444-8444-444444444444", 1), application("55555555-5555-4555-8555-555555555555", 2)],
    [],
    [],
    [],
    {
      rubricCriterionIds: ["python"],
      decidedApplicationIds: ["44444444-4444-4444-8444-444444444444"],
      currentOutcomes: [
        { applicationId: "44444444-4444-4444-8444-444444444444", criterionId: "python", kind: "supported" },
        { applicationId: "55555555-5555-4555-8555-555555555555", criterionId: "python", kind: "contradicted" }
      ],
      filters
    }
  );

const issues = (value: unknown): string =>
  applicationReviewQueueSchema.safeParse(value).error?.issues.map((issue) => issue.message).join(" ") ?? "";

test("a queue with review flags and filters satisfies the contract", () => {
  for (const queue of [reviewQueue(), reviewQueue(["contradiction"])]) {
    const parsed = applicationReviewQueueSchema.safeParse(queue);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  }
});

test("review counts that disagree with an unfiltered queue's entries are rejected", () => {
  const queue = reviewQueue();
  assert.match(
    issues({ ...queue, reviewFilterCounts: { ...queue.reviewFilterCounts, contradiction: 0 } }),
    /reviewFilterCounts must match the entries/
  );
});

test("an entry that matches none of the applied review filters is rejected", () => {
  const queue = reviewQueue(["contradiction"]);
  const decided = reviewQueue().entries[0];
  assert.ok(decided !== undefined);
  assert.match(issues({ ...queue, entries: [decided], shownCount: 1 }), /match one of the applied review filters/);
});

test("a failed extraction without the error flag, or flags out of order, is rejected", () => {
  const queue = reviewQueue();
  const entry = queue.entries[1];
  assert.ok(entry !== undefined);
  assert.match(
    issues({
      ...queue,
      entries: [queue.entries[0], { ...entry, evidenceState: "extraction_failed", job: { state: "failed", attemptCount: 3, maxAttempts: 3 } }]
    }),
    /must carry the error flag/
  );
  assert.match(
    issues({ ...queue, entries: [queue.entries[0], { ...entry, reviewFlags: ["contradiction", "unreviewed"] }] }),
    /unique and in canonical order/
  );
});
