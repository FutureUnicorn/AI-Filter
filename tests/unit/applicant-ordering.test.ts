import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  buildApplicationReviewQueue,
  compareApplicationsBySourceOrder
} from "../../packages/domain/src/index.ts";
import type { Application } from "../../packages/domain/src/index.ts";

// AF-46: "Default queue order matches original application order, not a
// hidden score -- there is no score to sort by."

const roleId = "11111111-4111-4111-8111-111111111111";
const organizationId = "22222222-4222-4222-8222-222222222222";
const INTAKE_A = "aaaaaaaa-4aaa-4aaa-8aaa-aaaaaaaaaaaa";
const INTAKE_B = "bbbbbbbb-4bbb-4bbb-8bbb-bbbbbbbbbbbb";

function application(
  applicationId: string,
  intakeId: string,
  sourceRowNumber: number,
  createdAt: string,
  appliedAt?: string
): Application {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    applicationId,
    organizationId,
    roleId,
    intakeId,
    sourceRowNumber,
    candidateFullName: `Candidate ${sourceRowNumber}`,
    candidateEmail: `c${sourceRowNumber}@example.test`,
    ...(appliedAt === undefined ? {} : { appliedAt }),
    createdAt
  };
}

function order(applications: readonly Application[]): readonly string[] {
  return buildApplicationReviewQueue(roleId, applications, []).entries.map(
    (entry) => entry.application.applicationId
  );
}

test("within one import, the queue is the file's own row order", () => {
  const shared = "2026-08-29T12:00:00.000Z";
  const rows = [
    application("r3", INTAKE_A, 3, shared),
    application("r1", INTAKE_A, 1, shared),
    application("r2", INTAKE_A, 2, shared)
  ];
  assert.deepEqual(order(rows), ["r1", "r2", "r3"]);
});

test("two imports that share a createdAt stay contiguous instead of interleaving", () => {
  // The case this ticket exists for. AF-32's finalize inserts every
  // application for one CSV in a single transaction, and
  // DEFAULT CURRENT_TIMESTAMP is transaction-START time -- so every row
  // of one import carries an identical createdAt, and two imports whose
  // transactions began at the same instant tie on it.
  //
  // Tiebreaking on sourceRowNumber next would give A1, B1, A2, B2:
  // two employers' import batches shuffled into each other. Comparing
  // intakeId first keeps each import whole.
  const shared = "2026-08-29T12:00:00.000Z";
  const rows = [
    application("b2", INTAKE_B, 2, shared),
    application("a1", INTAKE_A, 1, shared),
    application("b1", INTAKE_B, 1, shared),
    application("a2", INTAKE_A, 2, shared)
  ];
  const result = order(rows);
  assert.deepEqual(result, ["a1", "a2", "b1", "b2"]);
  // Stated as the property, not just the literal: each intake occupies
  // one unbroken run.
  const intakeSequence = buildApplicationReviewQueue(roleId, rows, []).entries.map(
    (entry) => entry.application.intakeId
  );
  const runs = intakeSequence.filter((intakeId, index) => intakeId !== intakeSequence[index - 1]);
  assert.equal(runs.length, new Set(intakeSequence).size, "each import must occupy one contiguous run");
});

test("an earlier import comes first even when its rows are numbered higher", () => {
  const rows = [
    application("later-row1", INTAKE_B, 1, "2026-08-29T13:00:00.000Z"),
    application("earlier-row9", INTAKE_A, 9, "2026-08-29T12:00:00.000Z")
  ];
  assert.deepEqual(order(rows), ["earlier-row9", "later-row1"]);
});

test("appliedAt never reorders the queue: the file's order wins over the candidate's date", () => {
  // Sorting by appliedAt would be a different order, not the original
  // one -- and it is optional and self-reported, so it would also
  // reorder inconsistently depending on what the employer supplied.
  const shared = "2026-08-29T12:00:00.000Z";
  const rows = [
    application("row1", INTAKE_A, 1, shared, "2026-08-01T00:00:00.000Z"),
    application("row2", INTAKE_A, 2, shared, "2020-01-01T00:00:00.000Z"),
    application("row3", INTAKE_A, 3, shared)
  ];
  assert.deepEqual(order(rows), ["row1", "row2", "row3"]);
});

test("the order is total: any input permutation yields the identical queue", () => {
  const shared = "2026-08-29T12:00:00.000Z";
  const rows = [
    application("a1", INTAKE_A, 1, shared),
    application("a2", INTAKE_A, 2, shared),
    application("b1", INTAKE_B, 1, shared),
    application("b2", INTAKE_B, 2, "2026-08-29T13:00:00.000Z")
  ];
  const expected = order(rows);
  const permutations = [
    [3, 2, 1, 0],
    [1, 3, 0, 2],
    [2, 0, 3, 1],
    [0, 2, 1, 3]
  ];
  for (const permutation of permutations) {
    assert.deepEqual(order(permutation.map((index) => rows[index] as Application)), expected);
  }
});

test("the comparator is antisymmetric and reflexive, so Array.sort cannot depend on input order", () => {
  const shared = "2026-08-29T12:00:00.000Z";
  const first = application("a1", INTAKE_A, 1, shared);
  const second = application("b1", INTAKE_B, 1, shared);
  assert.ok(compareApplicationsBySourceOrder(first, second) < 0);
  assert.ok(compareApplicationsBySourceOrder(second, first) > 0);
  assert.equal(compareApplicationsBySourceOrder(first, first), 0);
});

test("nothing in the queue can act as a score: POL-003, checked on the shape it actually returns", () => {
  const shared = "2026-08-29T12:00:00.000Z";
  const queue = buildApplicationReviewQueue(
    roleId,
    [application("a1", INTAKE_A, 1, shared), application("a2", INTAKE_A, 2, shared)],
    []
  );
  const forbidden = /score|rank|rating|confidence|match|priority|percentile|weight/iu;
  const offenders: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (forbidden.test(key)) {
        offenders.push(`${path}.${key}`);
      }
      walk(nested, `${path}.${key}`);
    }
  };
  walk(queue, "queue");
  assert.deepEqual(offenders, [], `queue exposes ranking-shaped field(s): ${offenders.join(", ")}`);

  // And the ordering genuinely does not consult any numeric field other
  // than the row's own position in its file: reversing the only numeric
  // field present reverses the queue, nothing else does.
  assert.deepEqual(
    order([application("a2", INTAKE_A, 2, shared), application("a1", INTAKE_A, 1, shared)]),
    ["a1", "a2"]
  );
});
