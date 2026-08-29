import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_ENTITY_TYPE,
  CONTRACT_SCHEMA_VERSION,
  buildApplicationReviewQueue
} from "../../packages/domain/src/index.ts";
import type { Application, EvidenceExtractionRunRef } from "../../packages/domain/src/index.ts";

const roleId = "11111111-4111-4111-8111-111111111111";
const organizationId = "22222222-4222-4222-8222-222222222222";
const intakeId = "33333333-4333-4333-8333-333333333333";

function application(overrides: Partial<Application> & { readonly applicationId: string }): Application {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId,
    roleId,
    intakeId,
    sourceRowNumber: 1,
    candidateFullName: "Casey Rivera",
    candidateEmail: "casey@example.test",
    createdAt: "2026-08-29T12:00:00.000Z",
    ...overrides
  };
}

function run(entityId: string, createdAt: string, entityType = APPLICATION_ENTITY_TYPE): EvidenceExtractionRunRef {
  return { entityType, entityId, createdAt };
}

test("an empty role produces an empty queue, not a missing one", () => {
  const queue = buildApplicationReviewQueue(roleId, [], []);
  assert.deepEqual(queue, {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    roleId,
    totalCount: 0,
    pendingExtractionCount: 0,
    extractedCount: 0,
    appliedStates: [],
    shownCount: 0,
    entries: []
  });
});

test("an application with no extraction run is pending, and says so with a zero count", () => {
  const queue = buildApplicationReviewQueue(roleId, [application({ applicationId: "a" })], []);
  assert.equal(queue.totalCount, 1);
  assert.equal(queue.pendingExtractionCount, 1);
  assert.equal(queue.extractedCount, 0);
  assert.equal(queue.entries[0]?.evidenceState, "pending_extraction");
  assert.equal(queue.entries[0]?.extractionRunCount, 0);
  // Absent rather than a fabricated timestamp: nothing has run.
  assert.equal(queue.entries[0]?.lastExtractionAt, undefined);
});

test("the latest of several runs is reported, not the first or last seen", () => {
  const queue = buildApplicationReviewQueue(
    roleId,
    [application({ applicationId: "a" })],
    [
      run("a", "2026-08-29T09:00:00.000Z"),
      run("a", "2026-08-29T11:00:00.000Z"),
      run("a", "2026-08-29T10:00:00.000Z")
    ]
  );
  assert.equal(queue.entries[0]?.evidenceState, "extracted");
  assert.equal(queue.entries[0]?.extractionRunCount, 3);
  assert.equal(queue.entries[0]?.lastExtractionAt, "2026-08-29T11:00:00.000Z");
  assert.equal(queue.extractedCount, 1);
  assert.equal(queue.pendingExtractionCount, 0);
});

test("a run for a different entity type with a colliding id does not mark an application extracted", () => {
  // entity_id is generic text on AF-40's table, so a file intake and an
  // application could in principle carry the same id string. Matching on
  // id alone would report evidence that was never extracted for this
  // candidate -- the worst direction for this view to be wrong in.
  const queue = buildApplicationReviewQueue(
    roleId,
    [application({ applicationId: "a" })],
    [run("a", "2026-08-29T11:00:00.000Z", "file_intake")]
  );
  assert.equal(queue.entries[0]?.evidenceState, "pending_extraction");
  assert.equal(queue.entries[0]?.extractionRunCount, 0);
  assert.equal(queue.extractedCount, 0);
});

test("a run for an application that is not in this role's list is ignored entirely", () => {
  const queue = buildApplicationReviewQueue(
    roleId,
    [application({ applicationId: "a" })],
    [run("somebody-elses-application", "2026-08-29T11:00:00.000Z")]
  );
  assert.equal(queue.totalCount, 1);
  assert.equal(queue.pendingExtractionCount, 1);
  assert.equal(queue.entries.length, 1);
});

test("ordering is total and deterministic: same input in any order yields the same queue", () => {
  // Two applications sharing a createdAt AND a sourceRowNumber (two
  // intakes each have a row 1, finalized in the same transaction) is
  // exactly the case where a partial sort leaves the order up to the
  // input sequence. applicationId is the final tiebreak.
  const shared = { createdAt: "2026-08-29T12:00:00.000Z", sourceRowNumber: 1 };
  const first = application({ applicationId: "aaaa", ...shared });
  const second = application({ applicationId: "bbbb", ...shared });

  const forward = buildApplicationReviewQueue(roleId, [first, second], []);
  const reversed = buildApplicationReviewQueue(roleId, [second, first], []);

  assert.deepEqual(
    forward.entries.map((entry) => entry.application.applicationId),
    ["aaaa", "bbbb"]
  );
  assert.deepEqual(forward, reversed);
});

test("import order wins over row number: an earlier intake's row 9 precedes a later intake's row 1", () => {
  const earlier = application({
    applicationId: "later-id-earlier-import",
    sourceRowNumber: 9,
    createdAt: "2026-08-29T10:00:00.000Z"
  });
  const later = application({
    applicationId: "aaaa-earlier-id-later-import",
    sourceRowNumber: 1,
    createdAt: "2026-08-29T12:00:00.000Z"
  });
  const queue = buildApplicationReviewQueue(roleId, [later, earlier], []);
  assert.deepEqual(
    queue.entries.map((entry) => entry.application.applicationId),
    ["later-id-earlier-import", "aaaa-earlier-id-later-import"]
  );
});

test("counts always partition the total, whatever the mix", () => {
  const queue = buildApplicationReviewQueue(
    roleId,
    [
      application({ applicationId: "a", sourceRowNumber: 1 }),
      application({ applicationId: "b", sourceRowNumber: 2 }),
      application({ applicationId: "c", sourceRowNumber: 3 })
    ],
    [run("a", "2026-08-29T11:00:00.000Z")]
  );
  assert.equal(queue.totalCount, 3);
  assert.equal(queue.extractedCount, 1);
  assert.equal(queue.pendingExtractionCount, 2);
  assert.equal(queue.extractedCount + queue.pendingExtractionCount, queue.totalCount);
});

test("the input array is not mutated by sorting", () => {
  const applications = [
    application({ applicationId: "b", sourceRowNumber: 2 }),
    application({ applicationId: "a", sourceRowNumber: 1 })
  ];
  buildApplicationReviewQueue(roleId, applications, []);
  assert.deepEqual(
    applications.map((entry) => entry.applicationId),
    ["b", "a"]
  );
});
