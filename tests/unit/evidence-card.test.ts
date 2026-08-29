import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_OUTCOME_KINDS,
  buildEvidenceCard,
  buildEvidenceCardSet
} from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome, SourceCitation } from "../../packages/domain/src/index.ts";

const citation: SourceCitation = {
  document: "resume.pdf",
  pageOrSection: "Experience",
  offset: 120,
  quote: "Built and operated Python services in production for four years."
};

const RECORDED_AT = "2026-08-29T12:00:00.000Z";

const samples: Record<string, EvidenceOutcome> = {
  supported: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "supported", criterionId: "c", citation },
  partially_supported: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "partially_supported",
    criterionId: "c",
    citation
  },
  contradicted: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "contradicted", criterionId: "c", citation },
  unclear: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "unclear", criterionId: "c", citation },
  not_found: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId: "c" },
  processing: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "processing", criterionId: "c" },
  retrying: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "retrying", criterionId: "c", attempt: 2, maxAttempts: 3 },
  extraction_error: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    criterionId: "c",
    errorCode: "provider_unavailable",
    message: "Provider returned 503.",
    retryable: true
  },
  citation_invalid: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    criterionId: "c",
    reason: "Quote not found in the source text.",
    rejectedCitation: citation
  },
  invalid_source: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "invalid_source",
    criterionId: "c",
    reason: "Document was empty."
  },
  unsupported_file: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "unsupported_file",
    criterionId: "c",
    reason: "No parser for .pages files."
  },
  quarantined: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "quarantined",
    criterionId: "c",
    quarantineClass: "corrupt",
    reason: "Archive failed integrity check.",
    operatorActionRequired: true
  },
  failed: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "failed",
    criterionId: "c",
    errorCode: "exhausted",
    message: "Retries exhausted.",
    retryable: false
  }
};

test("every EvidenceOutcome kind produces a card, and none is left unhandled", () => {
  // The exhaustiveness guard is compile-time; this is the runtime half.
  // A kind added to the union without a case here would surface as an
  // unreachable-assertion throw rather than a silently blank card.
  for (const kind of EVIDENCE_OUTCOME_KINDS) {
    const outcome = samples[kind];
    assert.ok(outcome !== undefined, `no fixture for ${kind}`);
    const card = buildEvidenceCard(outcome, RECORDED_AT);
    assert.equal(card.kind, kind);
    assert.equal(card.criterionId, "c");
    assert.equal(card.recordedAt, RECORDED_AT);
  }
});

test("the four citing kinds carry the quote a recruiter verifies against", () => {
  for (const kind of ["supported", "partially_supported", "contradicted", "unclear"] as const) {
    const card = buildEvidenceCard(samples[kind] as EvidenceOutcome, RECORDED_AT);
    assert.equal(card.verifiable, true, `${kind} must be verifiable`);
    assert.ok(card.citations.length >= 1, `${kind} must carry a citation`);
    assert.equal(card.citations[0]?.citation.quote, citation.quote);
  }
});

test("a rejected citation is shown, labelled, and never counted as evidence", () => {
  // Hiding it would make a caught hallucination look like a criterion
  // that simply vanished.
  const card = buildEvidenceCard(samples.citation_invalid as EvidenceOutcome, RECORDED_AT);
  assert.equal(card.citations.length, 1);
  assert.equal(card.citations[0]?.role, "rejected");
  assert.equal(card.verifiable, false);
  assert.match(card.explanation ?? "", /not found in the source/i);
});

test("every non-citing kind explains why there is nothing to verify", () => {
  const nonCiting = EVIDENCE_OUTCOME_KINDS.filter(
    (kind) => !["supported", "partially_supported", "contradicted", "unclear"].includes(kind)
  );
  for (const kind of nonCiting) {
    const card = buildEvidenceCard(samples[kind] as EvidenceOutcome, RECORDED_AT);
    assert.equal(card.verifiable, false, `${kind} must not claim to be verifiable`);
    assert.ok(
      (card.explanation ?? "").length > 0,
      `${kind} must say why there is nothing to verify, rather than rendering an empty quote box`
    );
  }
});

test("cards come back in rubric order, not in the order outcomes were recorded", () => {
  const set = buildEvidenceCardSet(
    "app-1",
    ["third", "first", "second"],
    [
      { outcome: { ...(samples.supported as EvidenceOutcome), criterionId: "first" }, recordedAt: RECORDED_AT },
      { outcome: { ...(samples.not_found as EvidenceOutcome), criterionId: "second" }, recordedAt: RECORDED_AT },
      { outcome: { ...(samples.unclear as EvidenceOutcome), criterionId: "third" }, recordedAt: RECORDED_AT }
    ]
  );
  assert.deepEqual(
    set.cards.map((card) => card.criterionId),
    ["third", "first", "second"]
  );
});

test("a rubric criterion with nothing recorded is reported, never dropped", () => {
  // Silently omitting it would tell a recruiter the rubric was smaller
  // than it is -- the one failure this card exists to prevent.
  const set = buildEvidenceCardSet("app-1", ["present", "missing"], [
    { outcome: { ...(samples.supported as EvidenceOutcome), criterionId: "present" }, recordedAt: RECORDED_AT }
  ]);
  assert.equal(set.cards.length, 2);
  const missing = set.cards.find((card) => card.criterionId === "missing");
  assert.equal(missing?.kind, "processing");
  assert.equal(missing?.verifiable, false);
  assert.match(missing?.explanation ?? "", /no evidence has been recorded/i);
});

test("an outcome for a criterion the rubric does not name is not rendered", () => {
  // The rubric defines the card set. An orphaned outcome (a criterion
  // removed from the rubric after extraction ran) must not reappear as a
  // card for a criterion nobody is assessing against.
  const set = buildEvidenceCardSet("app-1", ["kept"], [
    { outcome: { ...(samples.supported as EvidenceOutcome), criterionId: "kept" }, recordedAt: RECORDED_AT },
    { outcome: { ...(samples.supported as EvidenceOutcome), criterionId: "removed" }, recordedAt: RECORDED_AT }
  ]);
  assert.deepEqual(set.cards.map((card) => card.criterionId), ["kept"]);
});

test("the newest recorded outcome supersedes an earlier one for the same criterion", () => {
  // How AF-49's append-only corrections will work without this changing.
  const set = buildEvidenceCardSet("app-1", ["c"], [
    { outcome: samples.supported as EvidenceOutcome, recordedAt: "2026-08-29T10:00:00.000Z" },
    { outcome: samples.not_found as EvidenceOutcome, recordedAt: "2026-08-29T12:00:00.000Z" }
  ]);
  assert.equal(set.cards[0]?.kind, "not_found");
  assert.equal(set.cards[0]?.recordedAt, "2026-08-29T12:00:00.000Z");
});

test("an older correction arriving after a newer one does not win", () => {
  const set = buildEvidenceCardSet("app-1", ["c"], [
    { outcome: samples.not_found as EvidenceOutcome, recordedAt: "2026-08-29T12:00:00.000Z" },
    { outcome: samples.supported as EvidenceOutcome, recordedAt: "2026-08-29T10:00:00.000Z" }
  ]);
  assert.equal(set.cards[0]?.kind, "not_found");
});

test("counts partition the card set", () => {
  const set = buildEvidenceCardSet("app-1", ["a", "b", "c"], [
    { outcome: { ...(samples.supported as EvidenceOutcome), criterionId: "a" }, recordedAt: RECORDED_AT },
    { outcome: { ...(samples.not_found as EvidenceOutcome), criterionId: "b" }, recordedAt: RECORDED_AT }
  ]);
  assert.equal(set.verifiableCount, 1);
  assert.equal(set.unverifiableCount, 2);
  assert.equal(set.verifiableCount + set.unverifiableCount, set.cards.length);
});
