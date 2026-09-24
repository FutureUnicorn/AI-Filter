import assert from "node:assert/strict";
import moduleHooks from "node:module";
import test from "node:test";

import {
  processNextEvidenceExtractionJob,
  runEvidenceExtractionWorker
} from "../../apps/worker/src/extraction.ts";
import { setWorkerTelemetryAdapterForTesting } from "../../apps/worker/src/observability.ts";
// Use the built package entrypoint because the worker imports the workspace
// package entrypoint too; importing src directly would create a second class
// identity and make this typed-error/instanceof test unlike production.
import { InferenceKillSwitchEngagedError } from "../../packages/ai/dist/index.js";
import { EVIDENCE_EXTRACTION_WORKFLOW_VERSION } from "../../packages/contracts/src/index.ts";
import {
  claimEvidenceExtractionJob,
  completeEvidenceExtractionJob,
  correctEvidenceOutcome,
  createCanonicalTextExtraction,
  createFileIntake,
  deferEvidenceExtractionJob,
  dropProbeSchema,
  enqueueEvidenceExtractionJob,
  getEvidenceExtractionJob,
  getEvidenceExtractionQueueMonitoringSnapshot,
  getInferenceUsage,
  listCurrentEvidenceOutcomesForApplication,
  listEvidenceExtractionRunsForEntities,
  markFileIntakeUploaded,
  provisionEvidenceExtractionQueueProbeSchema,
  recordFileValidationResult,
  recordWorkerHeartbeat,
  renewEvidenceExtractionJobLease,
  retryOrFailEvidenceExtractionJob
} from "../../packages/db/src/index.ts";
import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { AiAdapter, EvidenceOutcome } from "../../packages/domain/src/index.ts";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../packages/security/src/index.ts";

function requireDatabase(): string {
  const value = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];
  if (value === undefined || value.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set. See README.md.");
  }
  return value;
}

interface NextRequestLike extends Request {
  readonly cookies: { get(name: string): { value: string } | undefined };
}

interface EnqueueRouteModule {
  POST(
    request: NextRequestLike,
    context: { params: Promise<{ roleId: string; applicationId: string }> }
  ): Promise<Response>;
}

let routeResolutionRegistered = false;

async function loadEnqueueRoute(): Promise<{
  readonly route: EnqueueRouteModule;
  readonly NextRequest: new (url: string, init?: RequestInit) => NextRequestLike;
}> {
  if (!routeResolutionRegistered) {
    moduleHooks.registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (/\.[cm]?[jt]sx?$/u.test(specifier)) throw error;
          for (const extension of [".ts", ".js"]) {
            try {
              return nextResolve(`${specifier}${extension}`, context);
            } catch {
              continue;
            }
          }
          throw error;
        }
      }
    });
    routeResolutionRegistered = true;
  }
  const routeUrl = new URL(
    "../../apps/web/src/app/api/roles/[roleId]/applications/[applicationId]/evidence-extraction/route.ts",
    import.meta.url
  ).href;
  const nextServerUrl = new URL("../../apps/web/node_modules/next/server.js", import.meta.url).href;
  const [route, next] = await Promise.all([import(routeUrl), import(nextServerUrl)]);
  return {
    route: route as EnqueueRouteModule,
    NextRequest: (next as { NextRequest: new (url: string, init?: RequestInit) => NextRequestLike }).NextRequest
  };
}

test("the authenticated production endpoint enqueues once and replays the logical job", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const secret = "af102-synthetic-session-secret-at-least-32-characters";
  const environment = {
    APP_ENV: "test",
    DEPLOYMENT_COMMIT_SHA: "af102-test",
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: probe.schema,
    STORAGE_ENDPOINT: "http://127.0.0.1:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "synthetic",
    STORAGE_ACCESS_KEY_ID: "synthetic",
    STORAGE_SECRET_ACCESS_KEY: "synthetic-secret",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    WORKER_MAX_ATTEMPTS: "3",
    SESSION_SECRET: secret
  } as const;
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { route, NextRequest } = await loadEnqueueRoute();
  const send = () =>
    route.POST(
      new NextRequest(
        `http://localhost/api/roles/${probe.roleId}/applications/${probe.applicationId}/evidence-extraction`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "af102-route-replay",
            cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(probe.userId, secret))}`
          },
          body: JSON.stringify({ sourceIntakeId: probe.sourceIntakeId })
        }
      ),
      { params: Promise.resolve({ roleId: probe.roleId, applicationId: probe.applicationId }) }
    );
  const created = await send();
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { job: { jobId: string }; replayed: boolean };
  assert.equal(createdBody.replayed, false);
  const replay = await send();
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { job: { jobId: string }; replayed: boolean };
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.job.jobId, createdBody.job.jobId);
});

test("enqueue is idempotent, claims are exclusive, leases recover, and retry exhaustion is terminal", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const input = {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
    maxAttempts: 3
  } as const;
  const first = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, input);
  const replay = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, input);
  assert.equal(first.outcome, "enqueued");
  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.job.jobId, first.job.jobId);

  const claimTime = new Date(Date.now() + 1_000);
  const claims = await Promise.all([
    claimEvidenceExtractionJob(databaseUrl, probe.schema, {
      workerId: "worker-a",
      leaseDurationMs: 10_000,
      now: claimTime
    }),
    claimEvidenceExtractionJob(databaseUrl, probe.schema, {
      workerId: "worker-b",
      leaseDurationMs: 10_000,
      now: claimTime
    })
  ]);
  assert.equal(claims.filter((claim) => claim.job !== undefined).length, 1, "one job may have only one active owner");
  assert.equal(
    (await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
      workerId: "worker-c",
      leaseDurationMs: 10_000,
      now: new Date(claimTime.getTime() + 9_000)
    })).job,
    undefined,
    "a live lease must not be stolen"
  );
  const recoveredClaim = await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "worker-c",
    leaseDurationMs: 10_000,
    now: new Date(claimTime.getTime() + 10_001)
  });
  const recovered = recoveredClaim.job;
  assert.ok(recovered !== undefined);
  assert.equal(recovered.attemptCount, 2);
  assert.equal(recovered.leaseOwner, "worker-c");
  const originalOwner = claims.find((claim) => claim.job !== undefined)?.job?.leaseOwner;
  assert.ok(originalOwner !== undefined);
  assert.equal(
    await completeEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      jobId: recovered.jobId,
      workerId: originalOwner,
      attemptCount: 1,
      outcomes: [],
      now: new Date(claimTime.getTime() + 10_002)
    }),
    "lease_lost",
    "an expired owner must not complete work after another worker reclaimed it"
  );
  const retryAt = new Date(claimTime.getTime() + 11_000);
  assert.equal(
    await retryOrFailEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      jobId: recovered.jobId,
      workerId: "worker-c",
      attemptCount: recovered.attemptCount,
      failureCode: "provider_transient",
      retryable: true,
      availableAt: retryAt,
      now: new Date(claimTime.getTime() + 10_500)
    }),
    "retrying"
  );
  const finalClaimOutcome = await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "worker-d",
    leaseDurationMs: 10_000,
    now: retryAt
  });
  const finalClaim = finalClaimOutcome.job;
  assert.ok(finalClaim !== undefined);
  assert.equal(finalClaim.attemptCount, 3);
  assert.equal(
    await retryOrFailEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      jobId: finalClaim.jobId,
      workerId: "worker-d",
      attemptCount: finalClaim.attemptCount,
      failureCode: "provider_transient",
      retryable: true,
      availableAt: new Date(retryAt.getTime() + 1_000),
      now: retryAt
    }),
    "failed"
  );
  assert.equal((await getEvidenceExtractionJob(databaseUrl, probe.schema, probe.organizationId, finalClaim.jobId))?.state, "failed");

  await recordWorkerHeartbeat(databaseUrl, probe.schema, "worker-d", retryAt);
  const snapshot = await getEvidenceExtractionQueueMonitoringSnapshot(databaseUrl, probe.schema, retryAt);
  assert.equal(snapshot.failedJobs, 1);
  assert.equal(snapshot.readyJobs, 0);
  assert.equal(snapshot.totalAttempts, 3);
  assert.equal(snapshot.lastHeartbeatAt, retryAt.toISOString());
  assert.equal(snapshot.heartbeatAgeMs, 0);

  const requeued = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    ...input,
    now: new Date(retryAt.getTime() + 1_000)
  });
  assert.equal(requeued.outcome, "requeued");
  if (requeued.outcome !== "requeued") return;
  assert.equal(requeued.job.jobId, finalClaim.jobId, "operator retry reuses the logical job");
  assert.equal(requeued.job.state, "ready");
  assert.equal(requeued.job.attemptCount, 0);
});

test("attempt fencing rejects a stale claim even when a replacement uses the same worker label", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const queued = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-attempt-fence`,
    maxAttempts: 3
  });
  assert.equal(queued.outcome, "enqueued");
  if (queued.outcome !== "enqueued") return;
  const firstAt = new Date(Date.now() + 1_000);
  const first = (await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "shared-deployment-label",
    leaseDurationMs: 10_000,
    now: firstAt
  })).job;
  assert.ok(first !== undefined);
  const reclaimedAt = new Date(firstAt.getTime() + 10_001);
  const replacement = (await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "shared-deployment-label",
    leaseDurationMs: 10_000,
    now: reclaimedAt
  })).job;
  assert.ok(replacement !== undefined);
  assert.equal(replacement.attemptCount, first.attemptCount + 1);

  assert.equal(await renewEvidenceExtractionJobLease(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    jobId: queued.job.jobId,
    workerId: "shared-deployment-label",
    attemptCount: first.attemptCount,
    leaseDurationMs: 10_000,
    now: new Date(reclaimedAt.getTime() + 1)
  }), false);
  assert.equal(await deferEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    jobId: queued.job.jobId,
    workerId: "shared-deployment-label",
    attemptCount: first.attemptCount,
    failureCode: "budget_capped",
    availableAt: new Date(reclaimedAt.getTime() + 2_000),
    now: new Date(reclaimedAt.getTime() + 1)
  }), false);
  assert.equal(await completeEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    jobId: queued.job.jobId,
    workerId: "shared-deployment-label",
    attemptCount: first.attemptCount,
    outcomes: [],
    now: new Date(reclaimedAt.getTime() + 1)
  }), "lease_lost");
  assert.equal(await completeEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    jobId: queued.job.jobId,
    workerId: "shared-deployment-label",
    attemptCount: replacement.attemptCount,
    outcomes: [],
    now: new Date(reclaimedAt.getTime() + 2)
  }), "completed");
});

test("an application cannot be queued with a different same-role candidate document", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const first = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-source-binding-a`,
    maxAttempts: 3
  });
  assert.equal(first.outcome, "enqueued");

  const other = await createFileIntake(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    storageKey: "probe/other-candidate.pdf",
    declaredFilename: "other-candidate.pdf",
    declaredMimeType: "application/pdf",
    createdByUserId: probe.userId
  });
  assert.equal((await markFileIntakeUploaded(databaseUrl, probe.schema, other.intakeId)).outcome, "uploaded");
  assert.equal((await recordFileValidationResult(databaseUrl, probe.schema, other.intakeId, {
    sniffedMimeType: "application/pdf",
    sizeBytes: 128,
    sha256Hash: "c".repeat(64),
    validation: { outcome: "validated" }
  })).outcome, "recorded");
  await createCanonicalTextExtraction(databaseUrl, probe.schema, {
    intakeId: other.intakeId,
    pages: [{ pageNumber: 1, text: "A different candidate document.", characterCount: 31 }],
    quality: "full"
  });

  const conflicting = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: other.intakeId,
    rubricId: probe.rubricId,
    workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-source-binding-b`,
    maxAttempts: 3
  });
  assert.deepEqual(conflicting, { outcome: "source_conflict" });
});

test("a later machine completion cannot supersede a recruiter correction", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const outcomes = Array.from({ length: 5 }, (_, index): EvidenceOutcome => ({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "not_found",
    organizationId: probe.organizationId,
    candidateId: probe.applicationId,
    criterionId: `criterion_${index + 1}`
  }));
  const first = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-correction-a`,
    maxAttempts: 3
  });
  assert.equal(first.outcome, "enqueued");
  if (first.outcome !== "enqueued") return;
  const firstClaim = (await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "worker-before-correction",
    leaseDurationMs: 10_000
  })).job;
  assert.ok(firstClaim !== undefined);
  assert.equal(await completeEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    jobId: firstClaim.jobId,
    workerId: "worker-before-correction",
    attemptCount: firstClaim.attemptCount,
    outcomes
  }), "completed");

  const correction = await correctEvidenceOutcome(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    applicationId: probe.applicationId,
    criterionId: "criterion_1",
    outcome: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "supported",
      organizationId: probe.organizationId,
      candidateId: probe.applicationId,
      criterionId: "criterion_1",
      citation: {
        document: "application_document",
        pageOrSection: "1",
        offset: 0,
        quote: "Built and operated PostgreSQL services"
      }
    },
    correctedByUserId: probe.userId,
    reason: "Recruiter verified the source document."
  });
  assert.equal(correction.outcome, "recorded");

  const second = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-correction-b`,
    maxAttempts: 3
  });
  assert.equal(second.outcome, "enqueued");
  if (second.outcome !== "enqueued") return;
  const secondClaim = (await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "worker-after-correction",
    leaseDurationMs: 10_000
  })).job;
  assert.ok(secondClaim !== undefined);
  assert.equal(await completeEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    jobId: secondClaim.jobId,
    workerId: "worker-after-correction",
    attemptCount: secondClaim.attemptCount,
    outcomes
  }), "completed");

  const current = await listCurrentEvidenceOutcomesForApplication(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    probe.applicationId
  );
  assert.equal(current.length, 5);
  assert.equal(
    current.find(({ outcome }) => outcome.criterionId === "criterion_1")?.outcome.kind,
    "supported"
  );
});

test("a transient claim failure is reported and the worker loop keeps polling", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  t.mock.method(console, "error", () => undefined);
  const captures: Error[] = [];
  setWorkerTelemetryAdapterForTesting({
    captureException(error) {
      captures.push(error);
    },
    startSpan(_options, callback) {
      return callback({ setStatus() { return undefined; }, setAttributes() { return undefined; } });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));
  const controller = new AbortController();
  let calls = 0;
  await runEvidenceExtractionWorker({
    databaseUrl,
    schema: probe.schema,
    adapterForModel() {
      throw new Error("provider must not be reached");
    },
    config: {
      enabled: true,
      workerId: "worker-claim-recovery",
      openAi: { apiKey: "not-used", defaultModel: "default-model", escalationModel: "escalation-model" },
      budget: {
        maxTokensPerPeriod: 10_000,
        alertThresholdRatio: 0.8,
        period: "month",
        estimatedOutputTokens: 200
      },
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 10_000,
      retryBaseDelayMs: 100,
      maxAttempts: 3
    }
  }, controller.signal, async () => {
    calls += 1;
    if (calls === 1) throw new Error("synthetic claim transport failure");
    controller.abort();
    return false;
  });
  assert.equal(calls, 2);
  assert.equal(captures.length, 1);
  assert.equal(captures[0]?.message, "Unexpected worker failure");
});

test("the production worker reports a crash-exhausted lease exactly once after durable failure", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const enqueue = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-crash-exhaustion`,
    maxAttempts: 1
  });
  assert.ok("job" in enqueue);
  if (!("job" in enqueue)) return;

  const claimedAt = new Date(Date.now() + 1_000);
  const initialClaim = await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "worker-that-crashes",
    leaseDurationMs: 10_000,
    now: claimedAt
  });
  assert.equal(initialClaim.job?.jobId, enqueue.job.jobId);
  assert.equal(initialClaim.exhaustedLeaseFailures, 0);

  const captures: Array<{ readonly error: Error; readonly context: { readonly tags: Record<string, string> } }> = [];
  const errorLines: string[] = [];
  t.mock.method(console, "error", (line?: unknown) => {
    errorLines.push(String(line));
  });
  setWorkerTelemetryAdapterForTesting({
    captureException(error, context) {
      captures.push({ error, context });
    },
    startSpan(_options, callback) {
      return callback({ setStatus() { return undefined; }, setAttributes() { return undefined; } });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));

  const afterLeaseExpiry = new Date(claimedAt.getTime() + 10_001);
  const dependencies = {
    databaseUrl,
    schema: probe.schema,
    now: () => afterLeaseExpiry,
    adapterForModel: () => {
      throw new Error("provider must not run for an exhausted lease");
    },
    config: {
      enabled: true as const,
      workerId: "worker-recovery",
      openAi: { apiKey: "not-used", defaultModel: "default-model", escalationModel: "escalation-model" },
      budget: {
        maxTokensPerPeriod: 10_000,
        alertThresholdRatio: 0.8,
        period: "month" as const,
        estimatedOutputTokens: 200
      },
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 10_000,
      retryBaseDelayMs: 100,
      maxAttempts: 1
    }
  };

  assert.equal(await processNextEvidenceExtractionJob(dependencies), false);
  const failed = await getEvidenceExtractionJob(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    enqueue.job.jobId
  );
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.failureCode, "lease_expired_exhausted");
  assert.equal(captures.length, 1);
  assert.equal(captures[0]?.error.message, "Unexpected worker failure");
  assert.equal(captures[0]?.context.tags.operation, "worker.job");
  assert.equal(captures[0]?.context.tags.failure_code, "lease_expired_exhausted");
  assert.equal(errorLines.filter((line) => line.includes("worker.job_failed")).length, 1);
  const terminalOutcomes = await listCurrentEvidenceOutcomesForApplication(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    probe.applicationId
  );
  assert.equal(terminalOutcomes.length, 5);
  assert.ok(terminalOutcomes.every(({ outcome }) => outcome.kind === "failed"));
  const telemetry = JSON.stringify({ captures, errorLines });
  assert.equal(telemetry.includes(probe.organizationId), false);
  assert.equal(telemetry.includes(probe.applicationId), false);
  assert.equal(telemetry.includes(enqueue.job.jobId), false);

  assert.equal(await processNextEvidenceExtractionJob(dependencies), false);
  assert.equal(captures.length, 1, "a durable terminal transition must not be reported twice");
  assert.equal(errorLines.filter((line) => line.includes("worker.job_failed")).length, 1);
});

test("queue monitoring snapshot selects the oldest recoverable backlog with a fixed clock", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));

  const emptyObservedAt = new Date("2030-01-01T00:00:00.000Z");
  assert.deepEqual(
    await getEvidenceExtractionQueueMonitoringSnapshot(databaseUrl, probe.schema, emptyObservedAt),
    {
      observedAt: emptyObservedAt.toISOString(),
      oldestReadyAgeMs: null,
      readyJobs: 0,
      runningJobs: 0,
      failedJobs: 0,
      completedJobs: 0,
      totalAttempts: 0,
      lastHeartbeatAt: null,
      heartbeatAgeMs: null
    }
  );

  const jobs = [];
  for (const suffix of ["one", "two", "three"]) {
    const queued = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      roleId: probe.roleId,
      applicationId: probe.applicationId,
      sourceIntakeId: probe.sourceIntakeId,
      rubricId: probe.rubricId,
      workflowVersion: `${EVIDENCE_EXTRACTION_WORKFLOW_VERSION}-monitoring-${suffix}`,
      maxAttempts: 3
    });
    assert.equal(queued.outcome, "enqueued");
    if (queued.outcome === "enqueued") jobs.push(queued.job);
  }
  assert.equal(jobs.length, 3);

  const allEnqueued = jobs.map((job) => new Date(job.enqueuedAt).getTime());
  const readyObservedAt = new Date(Math.max(...allEnqueued) + 1_000);
  const readySnapshot = await getEvidenceExtractionQueueMonitoringSnapshot(
    databaseUrl,
    probe.schema,
    readyObservedAt
  );
  assert.equal(readySnapshot.readyJobs, 3);
  assert.equal(readySnapshot.runningJobs, 0);
  assert.equal(readySnapshot.oldestReadyAgeMs, readyObservedAt.getTime() - Math.min(...allEnqueued));

  const claimedOutcome = await claimEvidenceExtractionJob(databaseUrl, probe.schema, {
    workerId: "worker-monitoring",
    leaseDurationMs: 10_000,
    now: readyObservedAt
  });
  const claimed = claimedOutcome.job;
  assert.ok(claimed !== undefined);

  const remainingEnqueued = jobs
    .filter((job) => job.jobId !== claimed.jobId)
    .map((job) => new Date(job.enqueuedAt).getTime());
  const liveLeaseObservedAt = new Date(readyObservedAt.getTime() + 5_000);
  const liveLeaseSnapshot = await getEvidenceExtractionQueueMonitoringSnapshot(
    databaseUrl,
    probe.schema,
    liveLeaseObservedAt
  );
  assert.equal(liveLeaseSnapshot.readyJobs, 2, "a live running lease is not ready backlog");
  assert.equal(liveLeaseSnapshot.runningJobs, 1);
  assert.equal(
    liveLeaseSnapshot.oldestReadyAgeMs,
    liveLeaseObservedAt.getTime() - Math.min(...remainingEnqueued)
  );

  const expiredLeaseObservedAt = new Date(readyObservedAt.getTime() + 10_001);
  const expiredLeaseSnapshot = await getEvidenceExtractionQueueMonitoringSnapshot(
    databaseUrl,
    probe.schema,
    expiredLeaseObservedAt
  );
  assert.equal(expiredLeaseSnapshot.readyJobs, 3, "an expired retryable lease is recoverable backlog");
  assert.equal(expiredLeaseSnapshot.runningJobs, 0);
  assert.equal(
    expiredLeaseSnapshot.oldestReadyAgeMs,
    expiredLeaseObservedAt.getTime() - Math.min(...allEnqueued)
  );
});

test("the real worker path calls the provider once and atomically records budget, run, outcomes, and completion", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const enqueue = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
    maxAttempts: 3
  });
  assert.ok("job" in enqueue);
  if (!("job" in enqueue)) return;

  const spans: Array<Record<string, unknown>> = [];
  setWorkerTelemetryAdapterForTesting({
    captureException() { return undefined; },
    startSpan(options, callback) {
      spans.push(options);
      return callback({ setStatus() { return undefined; }, setAttributes() { return undefined; } });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));
  let providerCalls = 0;
  const adapter: AiAdapter = {
    async runStructuredCall(input) {
      providerCalls += 1;
      assert.match(input.userPrompt, /criterion_1/u);
      assert.match(input.userPrompt, /PostgreSQL services/u);
      return {
        output: {
          items: Array.from({ length: 5 }, (_, index) => ({
            criterion_id: `criterion_${index + 1}`,
            state: "not_found",
            quote: "",
            source: { document: "application_document", page_or_section: "", offset: -1 },
            conflicting: null
          }))
        },
        metadata: {
          provider: "openai",
          model: "default-model",
          resolvedModel: "default-model-2026-09-01",
          promptVersion: input.promptVersion,
          schemaVersion: input.schemaVersion,
          schemaName: input.schemaName,
          usage: { inputTokens: 400, outputTokens: 100 }
        }
      };
    }
  };
  const now = new Date(Date.now() + 1_000);
  const processed = await processNextEvidenceExtractionJob({
    databaseUrl,
    schema: probe.schema,
    now: () => now,
    adapterForModel(model) {
      assert.equal(model, "default-model");
      return adapter;
    },
    config: {
      enabled: true,
      workerId: "worker-production-path",
      openAi: { apiKey: "not-used", defaultModel: "default-model", escalationModel: "escalation-model" },
      budget: {
        maxTokensPerPeriod: 10_000,
        alertThresholdRatio: 0.8,
        period: "month",
        estimatedOutputTokens: 200
      },
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 10_000,
      retryBaseDelayMs: 100,
      maxAttempts: 3
    }
  });
  assert.equal(processed, true);
  assert.equal(providerCalls, 1);
  assert.equal((await getEvidenceExtractionJob(databaseUrl, probe.schema, probe.organizationId, enqueue.job.jobId))?.state, "completed");
  const outcomes = await listCurrentEvidenceOutcomesForApplication(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    probe.applicationId
  );
  assert.equal(outcomes.length, 5);
  assert.ok(outcomes.every(({ outcome }) => outcome.kind === "not_found"));
  const runs = await listEvidenceExtractionRunsForEntities(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    "application",
    [probe.applicationId]
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.entityId, probe.applicationId);
  assert.deepEqual(
    await getInferenceUsage(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      model: "default-model",
      periodStart: `${now.toISOString().slice(0, 7)}-01`
    }),
    { inputTokens: 400, outputTokens: 100 }
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "inference.token_budget");
  assert.doesNotMatch(JSON.stringify(spans), /candidate|application|criterion|PostgreSQL|organization/iu);
});

test("a renewal query error is reported but does not discard a valid provider result", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const enqueue = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
    maxAttempts: 3
  });
  assert.equal(enqueue.outcome, "enqueued");
  if (enqueue.outcome !== "enqueued") return;
  const captures: Error[] = [];
  t.mock.method(console, "error", () => undefined);
  setWorkerTelemetryAdapterForTesting({
    captureException(error) {
      captures.push(error);
    },
    startSpan(_options, callback) {
      return callback({ setStatus() { return undefined; }, setAttributes() { return undefined; } });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));

  let renewalCalls = 0;
  let allowProviderResult: (() => void) | undefined;
  const secondRenewal = new Promise<void>((resolve) => {
    allowProviderResult = resolve;
  });
  const adapter: AiAdapter = {
    async runStructuredCall(input) {
      await secondRenewal;
      return {
        output: {
          items: Array.from({ length: 5 }, (_, index) => ({
            criterion_id: `criterion_${index + 1}`,
            state: "not_found",
            quote: "",
            source: { document: "application_document", page_or_section: "", offset: -1 },
            conflicting: null
          }))
        },
        metadata: {
          provider: "openai",
          model: "default-model",
          promptVersion: input.promptVersion,
          schemaVersion: input.schemaVersion,
          schemaName: input.schemaName,
          usage: { inputTokens: 400, outputTokens: 100 }
        }
      };
    }
  };
  const processed = await processNextEvidenceExtractionJob({
    databaseUrl,
    schema: probe.schema,
    adapterForModel: () => adapter,
    renewLease: async () => {
      renewalCalls += 1;
      if (renewalCalls === 1) throw new Error("synthetic renewal transport failure");
      allowProviderResult?.();
      return true;
    },
    config: {
      enabled: true,
      workerId: "worker-renewal-recovery",
      openAi: { apiKey: "not-used", defaultModel: "default-model", escalationModel: "escalation-model" },
      budget: {
        maxTokensPerPeriod: 10_000,
        alertThresholdRatio: 0.8,
        period: "month",
        estimatedOutputTokens: 200
      },
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1,
      leaseDurationMs: 10_000,
      retryBaseDelayMs: 100,
      maxAttempts: 3
    }
  });
  assert.equal(processed, true);
  assert.ok(renewalCalls >= 2);
  assert.equal(captures.length, 1);
  assert.equal(
    (await getEvidenceExtractionJob(databaseUrl, probe.schema, probe.organizationId, enqueue.job.jobId))?.state,
    "completed"
  );
});

test("transient provider failures back off, exhaust the bound, and surface safe failed outcomes", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const enqueue = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
    maxAttempts: 2
  });
  assert.ok("job" in enqueue);
  if (!("job" in enqueue)) return;
  let now = new Date(Date.now() + 1_000);
  let calls = 0;
  const captures: Array<{ readonly error: Error; readonly context: { readonly tags: Record<string, string> } }> = [];
  const errorLines: string[] = [];
  t.mock.method(console, "error", (line?: unknown) => {
    errorLines.push(String(line));
  });
  setWorkerTelemetryAdapterForTesting({
    captureException(error, context) {
      captures.push({ error, context });
    },
    startSpan(_options, callback) {
      return callback({ setStatus() { return undefined; }, setAttributes() { return undefined; } });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));
  const unavailable: AiAdapter = {
    async runStructuredCall() {
      calls += 1;
      throw Object.assign(new Error("synthetic provider outage containing candidate@example.test"), { status: 503 });
    }
  };
  const dependencies = {
    databaseUrl,
    schema: probe.schema,
    now: () => now,
    adapterForModel: () => unavailable,
    config: {
      enabled: true as const,
      workerId: "worker-retry-path",
      openAi: { apiKey: "not-used", defaultModel: "default-model", escalationModel: "escalation-model" },
      budget: {
        maxTokensPerPeriod: 10_000,
        alertThresholdRatio: 0.8,
        period: "month" as const,
        estimatedOutputTokens: 200
      },
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 10_000,
      retryBaseDelayMs: 100,
      maxAttempts: 2
    }
  };
  assert.equal(await processNextEvidenceExtractionJob(dependencies), true);
  assert.equal((await getEvidenceExtractionJob(databaseUrl, probe.schema, probe.organizationId, enqueue.job.jobId))?.state, "ready");
  assert.equal(captures.length, 0, "a retryable attempt must not emit a terminal failure");
  assert.equal(errorLines.some((line) => line.includes("worker.job_failed")), false);
  now = new Date(now.getTime() + 100);
  assert.equal(await processNextEvidenceExtractionJob(dependencies), true);
  const failed = await getEvidenceExtractionJob(databaseUrl, probe.schema, probe.organizationId, enqueue.job.jobId);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.failureCode, "provider_transient");
  assert.equal(calls, 2);
  assert.equal(captures.length, 1);
  assert.equal(captures[0]?.error.message, "Unexpected worker failure");
  assert.equal(captures[0]?.context.tags.operation, "worker.job");
  assert.equal(captures[0]?.context.tags.failure_code, "provider_transient");
  assert.equal(errorLines.filter((line) => line.includes("worker.job_failed")).length, 1);
  assert.doesNotMatch(JSON.stringify({ captures, errorLines }), /candidate@example\.test|provider outage/iu);
  assert.deepEqual(
    await getInferenceUsage(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      model: "default-model",
      periodStart: `${now.toISOString().slice(0, 7)}-01`
    }),
    { inputTokens: 0, outputTokens: 0 },
    "provider HTTP failures must settle each reservation to zero"
  );
  const outcomes = await listCurrentEvidenceOutcomesForApplication(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    probe.applicationId
  );
  assert.equal(outcomes.length, 5);
  assert.ok(outcomes.every(({ outcome }) => outcome.kind === "failed"));
  assert.doesNotMatch(JSON.stringify(outcomes), /candidate@example\.test|provider outage/iu);
});

test("kill-switch pauses defer without consuming attempts or leaking budget reservations", async (t) => {
  const databaseUrl = requireDatabase();
  const probe = await provisionEvidenceExtractionQueueProbeSchema(databaseUrl);
  t.after(() => dropProbeSchema(databaseUrl, probe.schema));
  const enqueue = await enqueueEvidenceExtractionJob(databaseUrl, probe.schema, {
    organizationId: probe.organizationId,
    roleId: probe.roleId,
    applicationId: probe.applicationId,
    sourceIntakeId: probe.sourceIntakeId,
    rubricId: probe.rubricId,
    workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
    maxAttempts: 3
  });
  assert.ok("job" in enqueue);
  if (!("job" in enqueue)) return;
  const now = new Date(Date.now() + 1_000);
  const paused: AiAdapter = {
    async runStructuredCall() {
      throw new InferenceKillSwitchEngagedError("synthetic drill");
    }
  };
  assert.equal(await processNextEvidenceExtractionJob({
    databaseUrl,
    schema: probe.schema,
    now: () => now,
    adapterForModel: () => paused,
    config: {
      enabled: true,
      workerId: "worker-kill-switch",
      openAi: { apiKey: "not-used", defaultModel: "default-model", escalationModel: "escalation-model" },
      budget: {
        maxTokensPerPeriod: 10_000,
        alertThresholdRatio: 0.8,
        period: "month",
        estimatedOutputTokens: 200
      },
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 10_000,
      retryBaseDelayMs: 100,
      maxAttempts: 3
    }
  }), true);
  const deferred = await getEvidenceExtractionJob(
    databaseUrl,
    probe.schema,
    probe.organizationId,
    enqueue.job.jobId
  );
  assert.equal(deferred?.state, "ready");
  assert.equal(deferred?.attemptCount, 0);
  assert.equal(deferred?.failureCode, "inference_paused");
  assert.deepEqual(
    await getInferenceUsage(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      model: "default-model",
      periodStart: `${now.toISOString().slice(0, 7)}-01`
    }),
    { inputTokens: 0, outputTokens: 0 }
  );
});
