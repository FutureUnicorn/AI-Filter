import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_REVIEW_FILTERS,
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_OUTCOME_KINDS,
  EVIDENCE_OUTCOME_KIND_CLASS,
  buildApplicationReviewQueue,
  deriveApplicationReviewFilters,
  parseApplicationReviewFilter,
  parseApplicationStateFilter
} from "../../packages/domain/src/index.ts";
import type {
  Application,
  ApplicationEvidenceState,
  CurrentEvidenceOutcomeKind,
  EvidenceOutcomeKind
} from "../../packages/domain/src/index.ts";

// AF-47: the four review filters, defined from persisted outcomes and
// decisions (approved by Hemnaath B, 2026-11-09).

const roleId = "11111111-4111-4111-8111-111111111111";
const RUBRIC = ["python", "postgres"] as const;

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

function flags(
  kinds: Partial<Record<(typeof RUBRIC)[number], EvidenceOutcomeKind>>,
  options: { hasDecision?: boolean; evidenceState?: ApplicationEvidenceState; rubric?: readonly string[] | undefined } = {}
) {
  return deriveApplicationReviewFilters({
    evidenceState: options.evidenceState ?? "extracted",
    hasDecision: options.hasDecision ?? true,
    rubricCriterionIds: "rubric" in options ? options.rubric : RUBRIC,
    currentOutcomes: Object.entries(kinds).map(([criterionId, kind]) => ({ criterionId, kind: kind as EvidenceOutcomeKind }))
  });
}

test("every outcome kind is classified exactly once", () => {
  assert.deepEqual(Object.keys(EVIDENCE_OUTCOME_KIND_CLASS).sort(), [...EVIDENCE_OUTCOME_KINDS].sort());
});

test("a decided application with complete, consistent evidence matches no filter", () => {
  assert.deepEqual(flags({ python: "supported", postgres: "partially_supported" }), []);
});

test("not_found is a finished answer, not incomplete", () => {
  assert.deepEqual(flags({ python: "supported", postgres: "not_found" }), []);
});

test("unreviewed means no recorded human decision, whatever the evidence says", () => {
  assert.deepEqual(flags({ python: "supported", postgres: "supported" }, { hasDecision: false }), ["unreviewed"]);
});

test("each incomplete kind, and a criterion with no outcome at all, is incomplete", () => {
  for (const kind of ["unclear", "processing", "retrying"] as const) {
    assert.deepEqual(flags({ python: "supported", postgres: kind }), ["incomplete"], kind);
  }
  assert.deepEqual(flags({ python: "supported" }), ["incomplete"], "a rubric criterion with no outcome");
  assert.deepEqual(flags({}), ["incomplete"], "nothing extracted yet");
});

test("contradicted is a contradiction", () => {
  assert.deepEqual(flags({ python: "contradicted", postgres: "supported" }), ["contradiction"]);
});

test("each error kind, and a failed extraction, is an error", () => {
  for (const kind of ["extraction_error", "citation_invalid", "invalid_source", "unsupported_file", "quarantined", "failed"] as const) {
    assert.deepEqual(flags({ python: kind, postgres: "supported" }), ["error"], kind);
  }
  assert.deepEqual(
    flags({ python: "supported", postgres: "supported" }, { evidenceState: "extraction_failed" }),
    ["error"]
  );
});

test("filters overlap and come back in canonical order", () => {
  assert.deepEqual(flags({ python: "contradicted", postgres: "failed" }, { hasDecision: false }), [
    "unreviewed",
    "contradiction",
    "error"
  ]);
  assert.deepEqual(flags({ python: "quarantined" }, { hasDecision: false }), ["unreviewed", "incomplete", "error"]);
});

test("an outcome under a criterion the rubric no longer has is ignored", () => {
  const result = deriveApplicationReviewFilters({
    evidenceState: "extracted",
    hasDecision: true,
    rubricCriterionIds: ["python"],
    currentOutcomes: [
      { criterionId: "python", kind: "supported" },
      { criterionId: "retired_criterion", kind: "contradicted" }
    ]
  });
  assert.deepEqual(result, []);
});

test("with no published rubric, there is nothing to be complete against", () => {
  assert.deepEqual(flags({ python: "supported" }, { rubric: undefined }), ["incomplete"]);
});

// ---- the queue ----

function queueFixture() {
  const applications = ["a", "b", "c", "d"].map((id, index) => application(id, index + 1));
  const outcome = (applicationId: string, criterionId: string, kind: EvidenceOutcomeKind): CurrentEvidenceOutcomeKind => ({
    applicationId,
    criterionId,
    kind
  });
  return {
    applications,
    review: {
      rubricCriterionIds: RUBRIC,
      decidedApplicationIds: ["a", "c"],
      currentOutcomes: [
        outcome("a", "python", "supported"),
        outcome("a", "postgres", "not_found"),
        outcome("b", "python", "contradicted"),
        outcome("b", "postgres", "supported"),
        outcome("c", "python", "failed"),
        outcome("c", "postgres", "supported"),
        outcome("d", "python", "unclear"),
        outcome("d", "postgres", "supported"),
        outcome("not-in-role", "python", "contradicted")
      ]
    }
  };
}

test("every entry carries its flags and the counts describe the whole role", () => {
  const { applications, review } = queueFixture();
  const queue = buildApplicationReviewQueue(roleId, applications, [], [], [], review);
  assert.deepEqual(
    queue.entries.map((entry) => [entry.application.applicationId, entry.reviewFlags]),
    [
      ["a", []],
      ["b", ["unreviewed", "contradiction"]],
      ["c", ["error"]],
      ["d", ["unreviewed", "incomplete"]]
    ]
  );
  assert.deepEqual(queue.reviewFilterCounts, { unreviewed: 2, incomplete: 1, contradiction: 1, error: 1 });
});

test("each filter selects exactly its applications, keeps import order, and leaves counts whole", () => {
  const { applications, review } = queueFixture();
  const expected: Record<string, string[]> = {
    unreviewed: ["b", "d"],
    incomplete: ["d"],
    contradiction: ["b"],
    error: ["c"]
  };
  for (const filter of APPLICATION_REVIEW_FILTERS) {
    const queue = buildApplicationReviewQueue(roleId, applications, [], [], [], { ...review, filters: [filter] });
    assert.deepEqual(queue.entries.map((entry) => entry.application.applicationId), expected[filter], filter);
    assert.equal(queue.totalCount, 4, filter);
    assert.deepEqual(queue.appliedFilters, [filter]);
    assert.deepEqual(queue.reviewFilterCounts, { unreviewed: 2, incomplete: 1, contradiction: 1, error: 1 });
  }
});

test("several filters match any of them, in import order, never re-sorted by how many they match", () => {
  const { applications, review } = queueFixture();
  const queue = buildApplicationReviewQueue(roleId, applications, [], [], [], {
    ...review,
    filters: ["error", "contradiction", "unreviewed"]
  });
  // b matches two filters and c matches one; b still comes first because it
  // came first in the file, not because it matched more.
  assert.deepEqual(queue.entries.map((entry) => entry.application.applicationId), ["b", "c", "d"]);
  assert.deepEqual(queue.appliedFilters, ["unreviewed", "contradiction", "error"], "canonical order, not request order");
});

test("a review filter and a processing-state filter must both match", () => {
  const { applications, review } = queueFixture();
  const parsedStates = parseApplicationStateFilter(["queued"]);
  assert.ok(parsedStates.ok);
  const queue = buildApplicationReviewQueue(
    roleId,
    applications,
    [],
    parsedStates.states,
    [{ applicationId: "d", state: "ready", enqueueGeneration: 1, attemptCount: 0, maxAttempts: 3 }],
    { ...review, filters: ["unreviewed"] }
  );
  assert.deepEqual(queue.entries.map((entry) => entry.application.applicationId), ["d"], "b is unreviewed but not queued");
});

test("parse rejects unknown, misspelled and empty review filters rather than dropping them", () => {
  assert.deepEqual(parseApplicationReviewFilter([]), { ok: true, filters: [] });
  assert.deepEqual(parseApplicationReviewFilter(["contradiction,error", "error"]), {
    ok: true,
    filters: ["contradiction", "error"]
  });
  assert.deepEqual(parseApplicationReviewFilter(["contradiciton"]), { ok: false, unknownValues: ["contradiciton"] });
  assert.deepEqual(parseApplicationReviewFilter(["error", "score"]), { ok: false, unknownValues: ["score"] });
  assert.deepEqual(parseApplicationReviewFilter([""]), { ok: false, unknownValues: [""] });
});
