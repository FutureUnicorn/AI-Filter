import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApplicantOrderingPreserved,
  assertApplicationQueueTenantIsolation
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
