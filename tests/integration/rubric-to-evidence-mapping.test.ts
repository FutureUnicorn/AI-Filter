import assert from "node:assert/strict";
import test from "node:test";

import { mapRubricToEvidence } from "../../packages/ai/src/index.ts";

// AF-13's review added organizationId and candidateId to every
// EvidenceOutcome, so the mapper has to be told who the outcomes are
// about -- there is nothing in a rubric or a model response that says.
const SUBJECT = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222"
} as const;
import type { EvidenceExtractionItem } from "../../packages/ai/src/index.ts";

function citing(criterionId: string, state: "supported" | "partially_supported" | "contradicted" | "unclear"): EvidenceExtractionItem {
  const item: EvidenceExtractionItem = {
    criterion_id: criterionId,
    state,
    quote: "Built and maintained Python microservices processing 2M+ events/day.",
    source: { document: "resume.txt", page_or_section: "Experience", offset: 0 }
  };
  if (state === "contradicted") {
    return {
      ...item,
      conflicting: {
        quote: "No production Python services; internships only.",
        source: { document: "cover-letter.txt", page_or_section: "Summary", offset: 12 }
      }
    };
  }
  return item;
}

function notFound(criterionId: string): EvidenceExtractionItem {
  return {
    criterion_id: criterionId,
    state: "not_found",
    quote: "",
    source: { document: "resume.txt", page_or_section: "", offset: -1 }
  };
}

test("produces exactly one outcome per rubric criterion, in rubric order", () => {
  const outcomes = mapRubricToEvidence(
    SUBJECT,
    ["python_production", "aws_certification"],
    [citing("python_production", "supported"), notFound("aws_certification")]
  );
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.criterionId, "python_production");
  assert.equal(outcomes[1]?.criterionId, "aws_certification");
});

test("a citing state maps quote/source into a citation with renamed fields", () => {
  const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [citing("python_production", "supported")]);
  if (outcome?.kind !== "supported") {
    assert.fail(`expected a supported outcome, got ${outcome?.kind}`);
  }
  assert.deepEqual(outcome.citation, {
    document: "resume.txt",
    pageOrSection: "Experience",
    offset: 0,
    quote: "Built and maintained Python microservices processing 2M+ events/day."
  });
});

test("not_found maps with no citation field at all", () => {
  const [outcome] = mapRubricToEvidence(SUBJECT, ["aws_certification"], [notFound("aws_certification")]);
  // The point of the deepEqual is that NO citation field appears -- a
  // not_found outcome carrying an empty citation would look like
  // evidence that was checked and found wanting. The attribution fields
  // are listed because AF-13's review made them required on every kind,
  // not because this test is about them.
  assert.deepEqual(outcome, {
    schemaVersion: outcome?.schemaVersion,
    kind: "not_found",
    organizationId: SUBJECT.organizationId,
    candidateId: SUBJECT.candidateId,
    criterionId: "aws_certification"
  });
});

test("a contradicted item with both sides maps to contradicted, not extraction_error", () => {
  const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [citing("python_production", "contradicted")]);
  assert.equal(outcome?.kind, "contradicted");
  if (outcome?.kind !== "contradicted") {
    return;
  }
  assert.deepEqual(outcome.citation, {
    document: "resume.txt",
    pageOrSection: "Experience",
    offset: 0,
    quote: "Built and maintained Python microservices processing 2M+ events/day."
  });
  assert.deepEqual(outcome.conflictingCitation, {
    document: "cover-letter.txt",
    pageOrSection: "Summary",
    offset: 12,
    quote: "No production Python services; internships only."
  });
});

test("a contradicted item missing the conflicting side stays a named extraction_error", () => {
  const half: EvidenceExtractionItem = {
    criterion_id: "python_production",
    state: "contradicted",
    quote: "Built and maintained Python microservices processing 2M+ events/day.",
    source: { document: "resume.txt", page_or_section: "Experience", offset: 0 }
  };
  const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [half]);
  assert.equal(outcome?.kind, "extraction_error");
  if (outcome?.kind === "extraction_error") {
    assert.equal(outcome.errorCode, "contradiction_missing_conflicting_citation");
    assert.equal(outcome.retryable, true);
  }
});

test("every outcome carries the attribution it was given, on every kind", () => {
  // Without this, a kind could quietly omit the fields and only fail
  // once something tried to persist it.
  const outcomes = mapRubricToEvidence(
    SUBJECT,
    ["a", "b", "c"],
    [citing("a", "supported"), notFound("b"), citing("c", "contradicted")]
  );
  assert.equal(outcomes.length, 3);
  for (const outcome of outcomes) {
    assert.equal(outcome.organizationId, SUBJECT.organizationId);
    assert.equal(outcome.candidateId, SUBJECT.candidateId);
  }
});

test("an empty attribution is rejected rather than producing unpersistable outcomes", () => {
  assert.throws(
    () => mapRubricToEvidence({ organizationId: "", candidateId: "c" }, ["a"], [notFound("a")]),
    /UUID organizationId/
  );
  assert.throws(
    () => mapRubricToEvidence({ organizationId: "   ", candidateId: "c" }, ["a"], [notFound("a")]),
    /UUID organizationId/
  );
  assert.throws(
    () =>
      mapRubricToEvidence(
        { organizationId: SUBJECT.organizationId, candidateId: "" },
        ["a"],
        [notFound("a")]
      ),
    /non-empty candidateId/
  );
});

test("a nonempty non-UUID organizationId is rejected rather than producing unpersistable outcomes", () => {
  // evidenceOutcomeSchema requires organizationId: z.uuid() on every
  // kind. "org-1" is nonempty, so a whitespace-only check used to let it
  // through and every generated outcome then failed the contract.
  assert.throws(
    () => mapRubricToEvidence({ organizationId: "org-1", candidateId: "c" }, ["a"], [notFound("a")]),
    /UUID organizationId/
  );
});

test("a criterion the model omitted becomes extraction_error, never a silently invented not_found", () => {
  const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production", "aws_certification"], [citing("python_production", "supported")]);
  const missing = mapRubricToEvidence(SUBJECT, ["aws_certification"], [])[0];
  assert.equal(missing?.kind, "extraction_error");
  assert.equal(missing?.kind === "extraction_error" ? missing.errorCode : undefined, "model_omitted_criterion");
  assert.equal(outcome?.kind, "supported");
});

test("a criterion the model answered twice becomes extraction_error, not an arbitrary pick", () => {
  const outcomes = mapRubricToEvidence(
    SUBJECT,
    ["python_production"],
    [citing("python_production", "supported"), citing("python_production", "contradicted")]
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.kind, "extraction_error");
  assert.equal(
    outcomes[0]?.kind === "extraction_error" ? outcomes[0].errorCode : undefined,
    "duplicate_criterion_response"
  );
});

test("a criterion_id the model invented outside the rubric is dropped, not surfaced", () => {
  const outcomes = mapRubricToEvidence(
    SUBJECT,
    ["python_production"],
    [citing("python_production", "supported"), citing("criterion_not_in_rubric", "supported")]
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.criterionId, "python_production");
});

test("a citing item with empty page_or_section or a negative offset becomes extraction_error", () => {
  const invalid: EvidenceExtractionItem = {
    criterion_id: "python_production",
    state: "supported",
    quote: "Built and maintained Python microservices processing 2M+ events/day.",
    source: { document: "resume.txt", page_or_section: "", offset: -1 }
  };
  const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [invalid]);
  assert.equal(outcome?.kind, "extraction_error");
  assert.equal(outcome?.kind === "extraction_error" ? outcome.errorCode : undefined, "invalid_citation");
});

test("every generated outcome is pinned to the same CONTRACT_SCHEMA_VERSION", () => {
  const outcomes = mapRubricToEvidence(
    SUBJECT,
    ["a", "b", "c"],
    [citing("a", "supported"), notFound("b")]
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.schemaVersion, outcomes[0]?.schemaVersion);
  }
});

// ---- AF-36 Codex findings: validate rubric IDs before building outcomes ----

test("an empty rubric criterion ID is rejected rather than producing an unpersistable outcome", () => {
  // mapRubricToEvidence(SUBJECT, [""], []) previously returned an extraction_error
  // whose criterionId was "", which fails evidenceOutcomeSchema -- a value
  // advertised as a persistable EvidenceOutcome that cannot be persisted.
  assert.throws(() => mapRubricToEvidence(SUBJECT, [""], []), /non-empty rubric criterion IDs/);
  assert.throws(() => mapRubricToEvidence(SUBJECT, ["python_production", ""], []), /non-empty rubric criterion IDs/);
});

test("a duplicated rubric criterion ID is rejected rather than emitting two outcomes for it", () => {
  // Mapping the array directly emitted one outcome per occurrence,
  // breaking the one-outcome-per-criterion invariant and letting a
  // downstream consumer persist or count the same criterion twice.
  assert.throws(
    () => mapRubricToEvidence(SUBJECT, ["python_production", "python_production"], []),
    /unique rubric criterion IDs.*python_production/
  );
});

test("every returned outcome still validates against the persisted contract", () => {
  // The property the two rejections above exist to protect.
  const outcomes = mapRubricToEvidence(SUBJECT, ["python_production", "aws_certification"], []);
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.ok(outcome.criterionId.length > 0);
  }
  assert.deepEqual(
    outcomes.map((outcome) => outcome.criterionId),
    ["python_production", "aws_certification"]
  );
});

// ---- a citing outcome must satisfy the whole citation contract ----
//
// The persistability check used to restate sourceCitationSchema's rules
// and omitted two of the four: a nonempty `document`, and an `offset` that
// is an INTEGER rather than merely non-negative. So an item could pass
// here and then fail the persisted contract downstream -- exactly what the
// check exists to prevent. It now parses the schema instead of restating
// it, because a restatement can drift and a parse cannot.

function withSource(source: EvidenceExtractionItem["source"]): EvidenceExtractionItem {
  return {
    criterion_id: "python_production",
    state: "supported",
    quote: "Built and maintained Python microservices.",
    source
  };
}

test("a citing item whose citation cannot persist becomes invalid_citation, not a citing outcome", () => {
  const rejected = [
    { label: "empty document", source: { document: "", page_or_section: "Experience", offset: 0 } },
    { label: "fractional offset", source: { document: "cv.pdf", page_or_section: "Experience", offset: 0.5 } },
    {
      label: "non-finite offset",
      source: { document: "cv.pdf", page_or_section: "Experience", offset: Number.POSITIVE_INFINITY }
    }
  ] as const;

  for (const { label, source } of rejected) {
    const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [withSource(source)]);
    assert.equal(outcome?.kind, "extraction_error", `${label} must not produce a citing outcome`);
    assert.equal(
      (outcome as { errorCode?: string }).errorCode,
      "invalid_citation",
      `${label} should be reported as an invalid citation`
    );
  }

  // The control: the same item with a citation that does satisfy the
  // contract still maps to a citing outcome, so the check is
  // discriminating rather than rejecting everything.
  const [ok] = mapRubricToEvidence(
    SUBJECT,
    ["python_production"],
    [withSource({ document: "cv.pdf", page_or_section: "Experience", offset: 0 })]
  );
  assert.equal(ok?.kind, "supported");
});

test("the conflicting side gets the same citation contract as the primary one", () => {
  // Both halves of a contradiction are persisted, so a second side that
  // fails sourceCitationSchema makes the whole outcome unpersistable.
  const base = {
    criterion_id: "python_production",
    state: "contradicted",
    quote: "Still in the role as of 2026.",
    source: { document: "cv.pdf", page_or_section: "Experience", offset: 0 }
  } as const;

  for (const bad of [
    { quote: "Left in 2019.", source: { document: "", page_or_section: "History", offset: 40 } },
    { quote: "Left in 2019.", source: { document: "cv.pdf", page_or_section: "History", offset: 1.5 } }
  ]) {
    const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [
      { ...base, conflicting: bad } as EvidenceExtractionItem
    ]);
    assert.equal(outcome?.kind, "extraction_error");
  }

  const [ok] = mapRubricToEvidence(SUBJECT, ["python_production"], [
    {
      ...base,
      conflicting: { quote: "Left in 2019.", source: { document: "cv.pdf", page_or_section: "History", offset: 40 } }
    } as EvidenceExtractionItem
  ]);
  assert.equal(ok?.kind, "contradicted", "a two-sided contradiction with valid citations still persists");
});
