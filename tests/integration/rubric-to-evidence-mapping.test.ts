import assert from "node:assert/strict";
import test from "node:test";

import { mapRubricToEvidence } from "../../packages/ai/src/index.ts";
import type { EvidenceExtractionItem, EvidenceSubject } from "../../packages/ai/src/index.ts";
import { evidenceOutcomeSchema } from "../../packages/contracts/src/index.ts";

const subject: EvidenceSubject = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  candidateId: "candidate-1"
};

function map(rubricCriterionIds: readonly string[], extractedItems: readonly EvidenceExtractionItem[]) {
  return mapRubricToEvidence(subject, rubricCriterionIds, extractedItems);
}

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
  const outcomes = map(
    ["python_production", "aws_certification"],
    [citing("python_production", "supported"), notFound("aws_certification")]
  );
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.criterionId, "python_production");
  assert.equal(outcomes[1]?.criterionId, "aws_certification");
  assert.equal(outcomes[0]?.organizationId, subject.organizationId);
  assert.equal(outcomes[1]?.candidateId, subject.candidateId);
});

test("a citing state maps quote/source into a citation with renamed fields", () => {
  const [outcome] = map(["python_production"], [citing("python_production", "supported")]);
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
  const [outcome] = map(["aws_certification"], [notFound("aws_certification")]);
  assert.deepEqual(outcome, {
    schemaVersion: outcome?.schemaVersion,
    kind: "not_found",
    organizationId: subject.organizationId,
    candidateId: subject.candidateId,
    criterionId: "aws_certification"
  });
});

test("a criterion the model omitted becomes extraction_error, never a silently invented not_found", () => {
  const [outcome] = map(["python_production", "aws_certification"], [citing("python_production", "supported")]);
  const missing = map(["aws_certification"], [])[0];
  assert.equal(missing?.kind, "extraction_error");
  assert.equal(missing?.kind === "extraction_error" ? missing.errorCode : undefined, "model_omitted_criterion");
  assert.equal(outcome?.kind, "supported");
});

test("a criterion the model answered twice becomes extraction_error, not an arbitrary pick", () => {
  const outcomes = map(
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
  const outcomes = map(
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
  const [outcome] = map(["python_production"], [invalid]);
  assert.equal(outcome?.kind, "extraction_error");
  assert.equal(outcome?.kind === "extraction_error" ? outcome.errorCode : undefined, "invalid_citation");
});

test("every generated outcome is pinned to the same CONTRACT_SCHEMA_VERSION", () => {
  const outcomes = map(
    ["a", "b", "c"],
    [citing("a", "supported"), notFound("b")]
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.schemaVersion, outcomes[0]?.schemaVersion);
  }
});

// ---- AF-36 Codex findings: validate rubric IDs before building outcomes ----

test("an empty rubric criterion ID is rejected rather than producing an unpersistable outcome", () => {
  // mapRubricToEvidence([""], []) previously returned an extraction_error
  // whose criterionId was "", which fails evidenceOutcomeSchema -- a value
  // advertised as a persistable EvidenceOutcome that cannot be persisted.
  assert.throws(() => map([""], []), /non-empty rubric criterion IDs/);
  assert.throws(() => map(["python_production", ""], []), /non-empty rubric criterion IDs/);
});

test("a duplicated rubric criterion ID is rejected rather than emitting two outcomes for it", () => {
  // Mapping the array directly emitted one outcome per occurrence,
  // breaking the one-outcome-per-criterion invariant and letting a
  // downstream consumer persist or count the same criterion twice.
  assert.throws(
    () => map(["python_production", "python_production"], []),
    /unique rubric criterion IDs.*python_production/
  );
});

test("every returned outcome still validates against the persisted contract", () => {
  // The property the two rejections above exist to protect.
  const outcomes = map(["python_production", "aws_certification"], []);
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.ok(outcome.criterionId.length > 0);
    evidenceOutcomeSchema.parse(outcome);
  }
  assert.deepEqual(
    outcomes.map((outcome) => outcome.criterionId),
    ["python_production", "aws_certification"]
  );
});
