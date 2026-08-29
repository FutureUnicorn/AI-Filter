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
  return {
    criterion_id: criterionId,
    state,
    quote: "Built and maintained Python microservices processing 2M+ events/day.",
    source: { document: "resume.txt", page_or_section: "Experience", offset: 0 }
  };
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

test("a contradicted item becomes a retryable extraction_error, not a half-reported contradiction", () => {
  // AF-13's review made ContradictedEvidence require BOTH sides of the
  // conflict, and an extraction item carries one quote. Constructing a
  // contradicted outcome with the second side missing would produce a
  // value that fails the persisted contract. It is also deliberately not
  // downgraded to `unclear`: conflicting evidence and ambiguous evidence
  // are different findings, and collapsing them loses the signal this
  // criterion most needs a human for.
  const [outcome] = mapRubricToEvidence(SUBJECT, ["python_production"], [citing("python_production", "contradicted")]);
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
  for (const subject of [
    { organizationId: "", candidateId: "c" },
    { organizationId: "o", candidateId: "" },
    { organizationId: "   ", candidateId: "c" }
  ]) {
    assert.throws(
      () => mapRubricToEvidence(subject, ["a"], [notFound("a")]),
      /non-empty organizationId and candidateId/
    );
  }
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
