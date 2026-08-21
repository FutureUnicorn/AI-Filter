import assert from "node:assert/strict";
import test from "node:test";

import { mapRubricToEvidence } from "../../packages/ai/src/index.ts";
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
    ["python_production", "aws_certification"],
    [citing("python_production", "supported"), notFound("aws_certification")]
  );
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.criterionId, "python_production");
  assert.equal(outcomes[1]?.criterionId, "aws_certification");
});

test("a citing state maps quote/source into a citation with renamed fields", () => {
  const [outcome] = mapRubricToEvidence(["python_production"], [citing("python_production", "supported")]);
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
  const [outcome] = mapRubricToEvidence(["aws_certification"], [notFound("aws_certification")]);
  assert.deepEqual(outcome, {
    schemaVersion: outcome?.schemaVersion,
    kind: "not_found",
    criterionId: "aws_certification"
  });
});

test("a criterion the model omitted becomes extraction_error, never a silently invented not_found", () => {
  const [outcome] = mapRubricToEvidence(["python_production", "aws_certification"], [citing("python_production", "supported")]);
  const missing = mapRubricToEvidence(["aws_certification"], [])[0];
  assert.equal(missing?.kind, "extraction_error");
  assert.equal(missing?.kind === "extraction_error" ? missing.errorCode : undefined, "model_omitted_criterion");
  assert.equal(outcome?.kind, "supported");
});

test("a criterion the model answered twice becomes extraction_error, not an arbitrary pick", () => {
  const outcomes = mapRubricToEvidence(
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
    ["python_production"],
    [citing("python_production", "supported"), citing("criterion_not_in_rubric", "supported")]
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.criterionId, "python_production");
});

test("every generated outcome is pinned to the same CONTRACT_SCHEMA_VERSION", () => {
  const outcomes = mapRubricToEvidence(
    ["a", "b", "c"],
    [citing("a", "supported"), notFound("b")]
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.schemaVersion, outcomes[0]?.schemaVersion);
  }
});
