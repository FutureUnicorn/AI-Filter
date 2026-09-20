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
    {
      itemId: "o-python",
      revisions: revisions.filter((r) => r.outcome.criterionId === "python_production"),
      examinedVia: "item_correction"
    },
    {
      itemId: "o-aws",
      revisions: revisions.filter((r) => r.outcome.criterionId === "aws_certification"),
      examinedVia: "candidate_decision"
    }
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

  const precision = summarizeEvidencePrecision([{ itemId: "o", revisions, examinedVia: "item_correction" }]);
  assert.equal(precision.correctedItems, 1);
  assert.equal(precision.correctionEvents, 2, "the card shows one correction; the metric still knows there were two");
});

test("a precision sample validates as a MetricSample for either dataset", () => {
  // Built per dataset, because each has its own record of what a human
  // examined and a sample cannot be moved from one to the other.
  const byDataset = {
    live_pilot: summarizeEvidencePrecision([
      { itemId: "a", revisions: [original("a", "c1")], examinedVia: "candidate_decision" }
    ]),
    locked_offline_eval: summarizeEvidencePrecision([
      { itemId: "a", revisions: [original("a", "c1")], examinedVia: "offline_annotation" }
    ])
  } as const;
  for (const dataset of ["live_pilot", "locked_offline_eval"] as const) {
    const sample = describeEvidencePrecision(byDataset[dataset], dataset, 1);
    metricSampleSchema.parse(sample);
    assert.equal(sample.metric, `evidence_precision_${dataset}`);
  }
});

test("a suppressed precision figure cannot smuggle a value past the contract", () => {
  const precision = summarizeEvidencePrecision([
    { itemId: "a", revisions: [original("a", "c1")], examinedVia: "candidate_decision" }
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
  const live = metricSampleSchema.parse(
    describeEvidencePrecision(
      summarizeEvidencePrecision([
        { itemId: "a", revisions: [original("a", "c1")], examinedVia: "candidate_decision" }
      ]),
      "live_pilot",
      1
    )
  );
  const offline = metricSampleSchema.parse(
    describeEvidencePrecision(
      summarizeEvidencePrecision([
        { itemId: "a", revisions: [original("a", "c1")], examinedVia: "offline_annotation" }
      ]),
      "locked_offline_eval",
      1
    )
  );
  assert.notEqual(live.metric, offline.metric);
});

test("only the items the reviewer's card shows as corrected can claim item-level examination", () => {
  // The provenance half of the same cross-module claim. AF-49's card set
  // is what a recruiter actually saw; the metric's denominator is what it
  // says they examined. An item whose card shows no correction has no
  // item-level record of being read, so claiming one has to fail here
  // rather than quietly firming up the denominator.
  const revisions = [
    original("o-python", "python_production"),
    correction("c-python", "python_production", "o-python"),
    original("o-aws", "aws_certification")
  ];
  const cards = buildCorrectedEvidenceCardSet(APPLICATION, ["python_production", "aws_certification"], revisions);
  const correctedCriteria = new Set(
    cards.cards.filter((card) => card.correction !== undefined).map((card) => card.criterionId)
  );

  for (const criterionId of ["python_production", "aws_certification"]) {
    const history = {
      itemId: criterionId,
      revisions: revisions.filter((r) => r.outcome.criterionId === criterionId),
      examinedVia: "item_correction"
    } as const;
    if (correctedCriteria.has(criterionId)) {
      assert.equal(summarizeEvidencePrecision([history]).correctedItems, 1);
    } else {
      assert.throws(
        () => summarizeEvidencePrecision([history]),
        /claims examinedVia item_correction but none of its revisions supersedes another/,
        `${criterionId} has no correction on its card and must not be able to claim one`
      );
    }
  }
});

test("the inference caveat survives the contract boundary as a code, not prose", () => {
  // A limitation a dashboard cannot branch on is a limitation nobody
  // applies. If examination_inferred were not in the closed set the
  // contract validates, this sample would be rejected outright rather
  // than arriving with the caveat attached.
  const precision = summarizeEvidencePrecision([
    { itemId: "a", revisions: [original("a", "c1")], examinedVia: "candidate_decision" },
    { itemId: "b", revisions: [original("b", "c2")], examinedVia: "candidate_decision" }
  ]);
  const sample = metricSampleSchema.parse(describeEvidencePrecision(precision, "live_pilot", 1));
  const inferred = sample.limitations.find((limitation) => limitation.code === "examination_inferred");
  assert.ok(inferred, "a denominator built from candidate-level decisions must say so in a code");
  assert.match(inferred.detail, /2 of 2 item\(s\)/);
  assert.equal(
    metricSampleSchema.safeParse({
      ...sample,
      limitations: [{ code: "examination_probably_fine", detail: "invented" }]
    }).success,
    false,
    "the code set is closed, so the caveat cannot be renamed into something softer"
  );
});
