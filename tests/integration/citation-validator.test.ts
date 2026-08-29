import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome } from "../../packages/domain/src/index.ts";
import { validateCitation } from "../../packages/ai/src/index.ts";
import { safeParseEvidenceOutcome } from "../../packages/contracts/src/index.ts";

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

test("an out-of-range offset is rejected, even when the quote is genuinely present", () => {
  // This test previously asserted the opposite -- that an out-of-range
  // offset was SKIPPED and the outcome passed on the strength of the
  // substring check alone. That was the bug: a claimed offset of 9999
  // into a much shorter document is not unverifiable, it is impossible,
  // and letting it through preserved a fabricated citation location as
  // valid evidence.
  const outcome = citing("supported", SOURCE_TEXT, 9999);
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
});

// ---- AF-38 Codex findings ----

function af38Citing(quote: string, offset: number): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "supported",
    organizationId: "11111111-1111-4111-8111-111111111111",
    criterionId: "python_production",
    citation: { document: "resume.txt", pageOrSection: "Experience", offset, quote }
  } as EvidenceOutcome;
}

test("a citation_invalid produced for an empty quote is itself contract-valid", () => {
  // rejectedCitation was typed as SourceCitation, whose quote requires
  // >= 1 char, so the validator emitted a citation_invalid that failed
  // evidenceOutcomeSchema and could be neither persisted nor routed to
  // human review -- the opposite of this kind's purpose.
  const result = validateCitation(af38Citing("", 0), "Built Python services.");
  assert.equal(result.kind, "citation_invalid");
  assert.equal(safeParseEvidenceOutcome(result).success, true);
});

test("an offset past the end of the source is rejected, not skipped", () => {
  // The old range guard skipped the coordinate check entirely for
  // out-of-range offsets, so an impossible location survived as valid
  // evidence provided the quote appeared somewhere in the text.
  const source = "Built Python services.";
  const result = validateCitation(af38Citing("Built", 9999), source);
  assert.equal(result.kind, "citation_invalid");
  assert.equal(safeParseEvidenceOutcome(result).success, true);
});

test("offsets are interpreted as code points, matching the Python validator", () => {
  // "😀Built": the emoji is one code point but two UTF-16 units, so the
  // Python offset of "Built" is 1 while a UTF-16 slice needs 2. Slicing
  // by the Python offset used to land inside the surrogate pair and
  // wrongly report citation_invalid.
  const source = "😀Built Python services.";
  assert.equal([...source].indexOf("B"), 1);
  assert.equal(source.indexOf("B"), 2);
  const result = validateCitation(af38Citing("Built", 1), source);
  assert.equal(result.kind, "supported", "a correct code-point offset must validate");
});

test("a genuinely wrong offset is still rejected once code points are used", () => {
  const result = validateCitation(af38Citing("Built", 5), "😀Built Python services.");
  assert.equal(result.kind, "citation_invalid");
});
