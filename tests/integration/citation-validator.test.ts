import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome } from "../../packages/domain/src/index.ts";
import { validateCitation } from "../../packages/ai/src/index.ts";
import { safeParseEvidenceOutcome } from "../../packages/contracts/src/index.ts";

const SOURCE_TEXT = "Built and maintained Python microservices processing 2M+ events/day.";

// A real substring of SOURCE_TEXT, located rather than hand-counted so the
// fixture cannot drift from the text it cites.
const CONFLICTING_QUOTE = "processing 2M+ events/day";

function conflictingCitation(quote = CONFLICTING_QUOTE, document = "resume.txt") {
  return {
    document,
    pageOrSection: "Experience",
    offset: SOURCE_TEXT.indexOf(quote),
    quote
  };
}

// A contradicted outcome carries TWO citations; building one with a single
// side made it structurally invalid, so every "contradicted" case here was
// exercising a shape the domain model does not permit.
function citing(kind: "supported" | "partially_supported" | "contradicted" | "unclear", quote: string, offset: number): EvidenceOutcome {
  const base = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind,
    organizationId: "11111111-1111-4111-8111-111111111111",
    candidateId: "22222222-2222-4222-8222-222222222222",
    criterionId: "python_production",
    citation: { document: "resume.txt", pageOrSection: "Experience", offset, quote }
  };
  return (kind === "contradicted"
    ? { ...base, conflictingCitation: conflictingCitation() }
    : base) as EvidenceOutcome;
}

const notFound: EvidenceOutcome = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  kind: "not_found",
  organizationId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
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
    assert.equal((result.rejectedCitation as { quote: string }).quote, "Designed PostgreSQL schemas for the core transactional workload");
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
    candidateId: "22222222-2222-4222-8222-222222222222",
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

// AF-38 review (#21). A contradicted outcome carries two citations, and
// only the primary was ever checked. A contradiction is a claim about both
// cited facts at once, so a fabricated opposing side is not half-valid
// evidence -- and it is the more damaging half to get wrong, because it is
// the side that argues against the candidate, displayed beside a real
// quote that lends it credibility.

test("a hallucinated conflicting citation is rejected, not passed through", () => {
  const outcome = {
    ...citing("contradicted", SOURCE_TEXT, 0),
    conflictingCitation: conflictingCitation("Never worked with Python in any production setting")
  } as EvidenceOutcome;
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
  if (result.kind === "citation_invalid") {
    assert.match(result.reason, /conflicting citation: .*not found verbatim/);
    // The rejected citation reported must be the side that actually
    // failed; reporting the valid primary would send a reviewer to the
    // wrong quote.
    assert.match((result.rejectedCitation as { quote: string }).quote, /Never worked with Python/);
  }
});

test("a conflicting citation at the wrong offset is rejected", () => {
  // The quote is genuinely present, so only the offset check catches this.
  const outcome = {
    ...citing("contradicted", SOURCE_TEXT, 0),
    conflictingCitation: { ...conflictingCitation(), offset: 0 }
  } as EvidenceOutcome;
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
  if (result.kind === "citation_invalid") {
    assert.match(result.reason, /conflicting citation: .*not at the claimed offset/);
  }
});

test("a contradiction whose two sides are both real passes", () => {
  // The control. Without it the two tests above would also pass if
  // validateCitation simply rejected every contradicted outcome.
  const outcome = citing("contradicted", SOURCE_TEXT, 0);
  assert.deepEqual(validateCitation(outcome, SOURCE_TEXT), outcome);
});

test("a contradicted outcome missing its second side fails closed rather than throwing", () => {
  const oneSided: Record<string, unknown> = { ...citing("contradicted", SOURCE_TEXT, 0) };
  delete oneSided["conflictingCitation"];
  const result = validateCitation(oneSided as unknown as EvidenceOutcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
  if (result.kind === "citation_invalid") {
    assert.match(result.reason, /no conflicting citation/);
  }
});

test("a cross-document contradiction is unverifiable against a single source, and fails closed", () => {
  // The quote is real -- but it is real in a document this caller did not
  // supply. Checking it against the resume would report a genuine citation
  // as a hallucination; skipping it would let an unchecked quote through.
  const outcome = {
    ...citing("contradicted", SOURCE_TEXT, 0),
    conflictingCitation: {
      document: "cover-letter.txt",
      pageOrSection: "p1",
      offset: 0,
      quote: "I have never used Python"
    }
  } as EvidenceOutcome;
  const result = validateCitation(outcome, SOURCE_TEXT);
  assert.equal(result.kind, "citation_invalid");
  if (result.kind === "citation_invalid") {
    assert.match(result.reason, /cover-letter\.txt.*no source text was supplied/s);
  }
});

test("a cross-document contradiction validates when each document's text is supplied", () => {
  const coverLetter = "I have never used Python professionally.";
  const outcome = {
    ...citing("contradicted", SOURCE_TEXT, 0),
    conflictingCitation: {
      document: "cover-letter.txt",
      pageOrSection: "p1",
      offset: 0,
      quote: "I have never used Python"
    }
  } as EvidenceOutcome;
  const sources = new Map([
    ["resume.txt", SOURCE_TEXT],
    ["cover-letter.txt", coverLetter]
  ]);
  assert.deepEqual(validateCitation(outcome, sources), outcome);

  // And the map form still catches a fabrication in the second document,
  // so it is a real check rather than a way to opt out of one.
  const fabricated = {
    ...outcome,
    conflictingCitation: {
      document: "cover-letter.txt",
      pageOrSection: "p1",
      offset: 0,
      quote: "I have never used Rust"
    }
  } as EvidenceOutcome;
  const result = validateCitation(fabricated, sources);
  assert.equal(result.kind, "citation_invalid");
});
