import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  buildCorrectedEvidenceCardSet,
  describeEvidencePrecision,
  summarizeEvidencePrecision
} from "../../packages/domain/src/index.ts";
import type { EvidenceRevision, SourceCitation } from "../../packages/domain/src/index.ts";
import { metricSampleSchema } from "../../packages/contracts/src/index.ts";

// AF-57. The metric counts an item as corrected; the reviewer's card
// shows an item as corrected. If those two ever disagree, the precision
// figure describes something no recruiter saw.

const ORG = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "22222222-2222-4222-8222-222222222222";
const APPLICATION = "33333333-3333-4333-8333-333333333333";
const CITATION: SourceCitation = {
  document: "resume.txt",
  pageOrSection: "Experience",
  offset: 0,
  quote: "Built and maintained Python microservices."
};

function original(evidenceOutcomeId: string, criterionId: string): EvidenceRevision {
  return {
    evidenceOutcomeId,
    outcome: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "supported",
      organizationId: ORG,
      candidateId: CANDIDATE,
      criterionId,
      citation: CITATION
    },
    recordedAt: "2026-08-29T12:00:00.000Z"
  };
}

function correction(evidenceOutcomeId: string, criterionId: string, supersedes: string): EvidenceRevision {
  return {
    evidenceOutcomeId,
    outcome: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "not_found",
      organizationId: ORG,
      candidateId: CANDIDATE,
      criterionId
    },
    recordedAt: "2026-08-29T13:00:00.000Z",
    correctedByUserId: "44444444-4444-4444-8444-444444444444",
    correctionReason: "the quote was from the job description, not the CV",
    supersedesEvidenceOutcomeId: supersedes
  };
}

test("what the metric counts as corrected is what the reviewer's card shows as corrected", () => {
  // The cross-module claim. AF-49 resolves the chain for the card; AF-57
  // counts corrections for the metric. Two independent readings of the
  // same revisions that have to agree.
  const revisions = [
    original("o-python", "python_production"),
    correction("c-python", "python_production", "o-python"),
    original("o-aws", "aws_certification")
  ];
  const cards = buildCorrectedEvidenceCardSet(APPLICATION, ["python_production", "aws_certification"], revisions);
  const cardsShowingCorrection = cards.cards.filter((card) => card.correction !== undefined).length;

  const precision = summarizeEvidencePrecision([
    { itemId: "o-python", revisions: revisions.filter((r) => r.outcome.criterionId === "python_production"), reviewed: true },
    { itemId: "o-aws", revisions: revisions.filter((r) => r.outcome.criterionId === "aws_certification"), reviewed: true }
  ]);

  assert.equal(cardsShowingCorrection, 1);
  assert.equal(precision.correctedItems, cardsShowingCorrection, "metric and card must count the same corrections");
  assert.equal(precision.precision, 0.5);
});

test("a chain of two corrections is one corrected card and one imprecise item", () => {
  const revisions = [
    original("o", "python_production"),
    correction("c1", "python_production", "o"),
    correction("c2", "python_production", "c1")
  ];
  const cards = buildCorrectedEvidenceCardSet(APPLICATION, ["python_production"], revisions);
  assert.equal(cards.cards.filter((card) => card.correction !== undefined).length, 1);

  const precision = summarizeEvidencePrecision([{ itemId: "o", revisions, reviewed: true }]);
  assert.equal(precision.correctedItems, 1);
  assert.equal(precision.correctionEvents, 2, "the card shows one correction; the metric still knows there were two");
});

test("a precision sample validates as a MetricSample for either dataset", () => {
  const precision = summarizeEvidencePrecision([
    { itemId: "a", revisions: [original("a", "c1")], reviewed: true }
  ]);
  for (const dataset of ["live_pilot", "locked_offline_eval"] as const) {
    const sample = describeEvidencePrecision(precision, dataset, 1);
    metricSampleSchema.parse(sample);
    assert.equal(sample.metric, `evidence_precision_${dataset}`);
  }
});

test("a suppressed precision figure cannot smuggle a value past the contract", () => {
  const precision = summarizeEvidencePrecision([
    { itemId: "a", revisions: [original("a", "c1")], reviewed: true }
  ]);
  const suppressed = describeEvidencePrecision(precision, "live_pilot", 50);
  assert.equal(suppressed.value, null);
  metricSampleSchema.parse(suppressed);
  assert.equal(metricSampleSchema.safeParse({ ...suppressed, value: 1 }).success, false);
});

test("the two datasets stay distinguishable after crossing the contract boundary", () => {
  // If both serialised to the same metric name, a dashboard would pool
  // them -- which is the exact failure the separate targets exist to
  // prevent.
  const precision = summarizeEvidencePrecision([
    { itemId: "a", revisions: [original("a", "c1")], reviewed: true }
  ]);
  const live = metricSampleSchema.parse(describeEvidencePrecision(precision, "live_pilot", 1));
  const offline = metricSampleSchema.parse(describeEvidencePrecision(precision, "locked_offline_eval", 1));
  assert.notEqual(live.metric, offline.metric);
});
