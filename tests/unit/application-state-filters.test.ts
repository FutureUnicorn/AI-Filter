import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_EVIDENCE_STATES,
  CONTRACT_SCHEMA_VERSION,
  buildApplicationReviewQueue,
  parseApplicationStateFilter
} from "../../packages/domain/src/index.ts";
import type { Application, EvidenceExtractionRunRef } from "../../packages/domain/src/index.ts";

// AF-47: "Filter by unreviewed/incomplete/contradiction/error state --
// explicit filters, never a hidden ranking."

const roleId = "11111111-4111-4111-8111-111111111111";
const INTAKE = "aaaaaaaa-4aaa-4aaa-8aaa-aaaaaaaaaaaa";

// Names are deliberately in the reverse of file order, and emails in a
// third order. A filter that quietly sorted by either would produce a
// different sequence from the file's -- which is what makes the
// "never reorders" test below able to catch a ranking wearing a
// filter's clothes, rather than passing because every field happened to
// agree with the row numbers.
const CANDIDATE_NAMES = ["Zoe Adams", "Yusuf Baker", "Xena Clarke", "Wendy Diaz"] as const;

function application(applicationId: string, sourceRowNumber: number): Application {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    applicationId,
    organizationId: "22222222-4222-4222-8222-222222222222",
    roleId,
    intakeId: INTAKE,
    sourceRowNumber,
    candidateFullName: CANDIDATE_NAMES[sourceRowNumber - 1] ?? `Candidate ${sourceRowNumber}`,
    candidateEmail: `${String.fromCharCode(100 + ((sourceRowNumber * 3) % 4))}@example.test`,
    createdAt: "2026-08-29T12:00:00.000Z"
  };
}

const applications = [
  application("a1", 1),
  application("a2", 2),
  application("a3", 3),
  application("a4", 4)
];
// a2 and a4 have been extracted; a1 and a3 have not.
const runs: readonly EvidenceExtractionRunRef[] = [
  { entityType: "application", entityId: "a2", createdAt: "2026-08-29T13:00:00.000Z" },
  { entityType: "application", entityId: "a4", createdAt: "2026-08-29T13:00:00.000Z" }
];

function shown(states: Parameters<typeof buildApplicationReviewQueue>[3]): readonly string[] {
  return buildApplicationReviewQueue(roleId, applications, runs, states).entries.map(
    (entry) => entry.application.applicationId
  );
}

test("no filter shows the whole queue, and reports no applied states", () => {
  const queue = buildApplicationReviewQueue(roleId, applications, runs);
  assert.deepEqual(queue.appliedStates, []);
  assert.equal(queue.shownCount, 4);
  assert.equal(queue.totalCount, 4);
});

test("a filter selects exactly the matching applications", () => {
  assert.deepEqual(shown(["pending_extraction"]), ["a1", "a3"]);
  assert.deepEqual(shown(["extracted"]), ["a2", "a4"]);
});

test("selecting every state is the same view as selecting none", () => {
  assert.deepEqual(shown([...APPLICATION_EVIDENCE_STATES]), ["a1", "a2", "a3", "a4"]);
});

test("counts describe the whole role, never the filtered view", () => {
  // The screen has to be able to say "showing 2 of 4". If filtering also
  // shrank the totals, a filtered page would read as though the role
  // only ever had 2 applications.
  const queue = buildApplicationReviewQueue(roleId, applications, runs, ["extracted"]);
  assert.equal(queue.totalCount, 4);
  assert.equal(queue.pendingExtractionCount, 2);
  assert.equal(queue.extractedCount, 2);
  assert.equal(queue.shownCount, 2);
  assert.equal(queue.entries.length, 2);
});

test("filtering never reorders: the filtered view is a subsequence of the unfiltered one", () => {
  // AF-46's guarantee has to survive AF-47. A filter that reordered
  // would be a ranking wearing a filter's clothes.
  const full = buildApplicationReviewQueue(roleId, applications, runs).entries.map(
    (entry) => entry.application.applicationId
  );
  for (const states of [["pending_extraction"], ["extracted"], [...APPLICATION_EVIDENCE_STATES]] as const) {
    const filtered = shown([...states]);
    const asSubsequence = full.filter((id) => filtered.includes(id));
    assert.deepEqual(filtered, asSubsequence, `filter ${states.join("+")} reordered the queue`);
  }
});

test("a filter matching nothing returns an empty view, not the whole queue", () => {
  const onlyPending = buildApplicationReviewQueue(roleId, [application("a1", 1)], [], ["extracted"]);
  assert.equal(onlyPending.shownCount, 0);
  assert.deepEqual(onlyPending.entries, []);
  // ...and still reports what it is hiding.
  assert.equal(onlyPending.totalCount, 1);
});

test("a repeated state is applied once, not twice", () => {
  const queue = buildApplicationReviewQueue(roleId, applications, runs, [
    "extracted",
    "extracted"
  ]);
  assert.deepEqual(queue.appliedStates, ["extracted"]);
  assert.equal(queue.shownCount, 2);
});

test("parse accepts repeated params and comma-separated values, de-duplicated", () => {
  assert.deepEqual(parseApplicationStateFilter(["extracted", "pending_extraction"]), {
    ok: true,
    states: ["extracted", "pending_extraction"]
  });
  assert.deepEqual(parseApplicationStateFilter(["extracted,pending_extraction"]), {
    ok: true,
    states: ["extracted", "pending_extraction"]
  });
  assert.deepEqual(parseApplicationStateFilter([" extracted , extracted "]), {
    ok: true,
    states: ["extracted"]
  });
});

test("an absent filter parses as no filter", () => {
  assert.deepEqual(parseApplicationStateFilter([]), { ok: true, states: [] });
});

test("an unknown state is rejected, never silently dropped", () => {
  // The failure this prevents: ?state=contradiction returning the entire
  // queue, which a recruiter would read as "these are the
  // contradictions". A filter that cannot be honoured must not look
  // like one that was.
  for (const bad of ["contradiction", "incomplete", "error", "EXTRACTED", "pending"]) {
    const parsed = parseApplicationStateFilter([bad]);
    assert.equal(parsed.ok, false, `expected ${bad} to be rejected`);
    if (!parsed.ok) {
      assert.deepEqual(parsed.unknownValues, [bad]);
    }
  }
});

test("one bad value poisons the whole filter rather than being dropped from a good one", () => {
  const parsed = parseApplicationStateFilter(["extracted", "contradiction"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.deepEqual(parsed.unknownValues, ["contradiction"]);
  }
});

test("an explicitly empty filter is a caller mistake, not 'show everything'", () => {
  // Same distinction AF-14 draws between a missing and an empty
  // Idempotency-Key header.
  const parsed = parseApplicationStateFilter([""]);
  assert.equal(parsed.ok, false);
});
