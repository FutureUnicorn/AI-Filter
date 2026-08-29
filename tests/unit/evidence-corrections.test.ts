import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  buildCorrectedEvidenceCard,
  resolveCurrentEvidenceRevisions
} from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome, EvidenceRevision, SourceCitation } from "../../packages/domain/src/index.ts";

// AF-49: "Recruiter corrections never overwrite the original AI output --
// before/after state is preserved for every correction."

const citation: SourceCitation = {
  document: "resume.pdf",
  pageOrSection: "Experience",
  offset: 12,
  quote: "Led the Postgres migration."
};

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function supported(criterionId: string): EvidenceOutcome {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "supported", criterionId, citation };
}
function notFound(criterionId: string): EvidenceOutcome {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId };
}

const original: EvidenceRevision = {
  evidenceOutcomeId: "rev-1",
  outcome: supported("postgres"),
  recordedAt: "2026-08-29T10:00:00.000Z"
};
const correction: EvidenceRevision = {
  evidenceOutcomeId: "rev-2",
  outcome: notFound("postgres"),
  recordedAt: "2026-08-29T11:00:00.000Z",
  correctedByUserId: USER,
  correctionReason: "That quote is from a different candidate's resume.",
  supersedesEvidenceOutcomeId: "rev-1"
};

test("the current revision is the one nothing supersedes, not the newest timestamp", () => {
  const heads = resolveCurrentEvidenceRevisions([original, correction]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0]?.evidenceOutcomeId, "rev-2");
});

test("a correction recorded with an EARLIER timestamp than what it replaced still wins", () => {
  // Chain order is a stored fact (0017's supersedes link), not an
  // inference from clocks. Two rows written in the same microsecond, or
  // any clock skew, must not be able to invert the history.
  const backdated: EvidenceRevision = { ...correction, recordedAt: "2026-08-29T09:00:00.000Z" };
  const heads = resolveCurrentEvidenceRevisions([original, backdated]);
  assert.equal(heads[0]?.evidenceOutcomeId, "rev-2");
});

test("the original is never overwritten: it is still in the history after correction", () => {
  const history = [original, correction];
  assert.ok(history.some((revision) => revision.evidenceOutcomeId === "rev-1"));
  assert.equal(history.find((r) => r.evidenceOutcomeId === "rev-1")?.outcome.kind, "supported");
});

test("a corrected card carries its own before AND after", () => {
  const card = buildCorrectedEvidenceCard([original, correction], correction);
  assert.equal(card.kind, "not_found");
  assert.equal(card.correction?.previousKind, "supported");
  assert.equal(card.correction?.correctedByUserId, USER);
  assert.match(card.correction?.reason ?? "", /different candidate/);
  // The quote the AI produced is preserved on the card, so a reviewer can
  // see what was corrected rather than only that something was.
  assert.equal(card.correction?.previousCitations[0]?.citation.quote, citation.quote);
  // ...and the corrected state carries no quote, because not_found has none.
  assert.deepEqual(card.citations, []);
});

test("an uncorrected card has no correction field at all, rather than an empty one", () => {
  const card = buildCorrectedEvidenceCard([original], original);
  assert.equal(card.correction, undefined);
});

test("a correction whose predecessor is missing does not claim a before it cannot show", () => {
  // Reporting "corrected" without the before state would show the card as
  // satisfying AF-49 while quietly failing it. 0016 makes deletion
  // impossible, so this can only mean an incomplete read.
  const card = buildCorrectedEvidenceCard([correction], correction);
  assert.equal(card.correction, undefined);
  assert.equal(card.kind, "not_found");
});

test("a chain of two corrections resolves to the last, and its before is the middle", () => {
  const second: EvidenceRevision = {
    evidenceOutcomeId: "rev-3",
    outcome: supported("postgres"),
    recordedAt: "2026-08-29T12:00:00.000Z",
    correctedByUserId: USER,
    correctionReason: "Re-checked; the original was right.",
    supersedesEvidenceOutcomeId: "rev-2"
  };
  const history = [original, correction, second];
  const heads = resolveCurrentEvidenceRevisions(history);
  assert.equal(heads.length, 1);
  assert.equal(heads[0]?.evidenceOutcomeId, "rev-3");
  const card = buildCorrectedEvidenceCard(history, second);
  assert.equal(card.kind, "supported");
  // The immediately preceding state, not the original.
  assert.equal(card.correction?.previousKind, "not_found");
});

test("criteria are independent: correcting one leaves the other's head alone", () => {
  const otherOriginal: EvidenceRevision = {
    evidenceOutcomeId: "rev-x",
    outcome: supported("python"),
    recordedAt: "2026-08-29T10:00:00.000Z"
  };
  const heads = resolveCurrentEvidenceRevisions([original, correction, otherOriginal]);
  assert.equal(heads.length, 2);
  const byCriterion = new Map(heads.map((h) => [h.outcome.criterionId, h.evidenceOutcomeId]));
  assert.equal(byCriterion.get("postgres"), "rev-2");
  assert.equal(byCriterion.get("python"), "rev-x");
});

test("an empty history resolves to no heads rather than throwing", () => {
  assert.deepEqual(resolveCurrentEvidenceRevisions([]), []);
});
