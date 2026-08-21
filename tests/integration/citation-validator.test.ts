import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome } from "../../packages/domain/src/index.ts";
import { validateCitation } from "../../packages/ai/src/index.ts";

const SOURCE_TEXT = "Built and maintained Python microservices processing 2M+ events/day.";

function citing(kind: "supported" | "partially_supported" | "contradicted" | "unclear", quote: string, offset: number): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind,
    criterionId: "python_production",
    citation: { document: "resume.txt", pageOrSection: "Experience", offset, quote }
  };
}

const notFound: EvidenceOutcome = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  kind: "not_found",
  criterionId: "aws_certification"
};

for (const kind of ["supported", "partially_supported", "contradicted", "unclear"] as const) {
  test(`a genuine verbatim quote at the correct offset passes for ${kind}`, () => {
    const outcome = citing(kind, SOURCE_TEXT, 0);
    assert.deepEqual(validateCitation(outcome, SOURCE_TEXT), outcome);
  });
}

test("a hallucinated quote that never appears in the source is rejected as citation_invalid", () => {
  const outcome = citing("supported", "Designed PostgreSQL schemas for the core transactional workload", 0);
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
  if (result.kind === "citation_invalid") {
    assert.match(result.reason, /not found verbatim/);
    assert.equal(result.rejectedCitation.quote, "Designed PostgreSQL schemas for the core transactional workload");
  }
});

test("a quote that exists in the source but not at the claimed offset is rejected", () => {
  const outcome = citing("supported", SOURCE_TEXT, 10);
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
  if (result.kind === "citation_invalid") {
    assert.match(result.reason, /not at the claimed offset/);
  }
});

test("an unclear outcome (not one of the ticket's three named states) is still validated, per the domain model", () => {
  const outcome = citing("unclear", "this text is not in the source at all", 0);
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
});

test("not_found and other non-citing outcomes pass through unexamined", () => {
  assert.deepEqual(validateCitation(notFound, SOURCE_TEXT), notFound);
});

test("citation_invalid preserves the criterionId of the discarded claim", () => {
  const outcome = citing("contradicted", "fabricated quote", 0);
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.criterionId, "python_production");
});

test("an out-of-range offset does not crash; the verbatim-substring check alone still applies", () => {
  const outcome = citing("supported", SOURCE_TEXT, 9999);
  const result = validateCitation(outcome, SOURCE_TEXT);
  // Offset is out of range so the offset check is skipped, but the quote is
  // genuinely present verbatim somewhere in the source, so it still passes.
  assert.deepEqual(result, outcome);
});
