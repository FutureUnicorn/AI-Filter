import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  describeEvidencePrecision,
  summarizeEvidencePrecision
} from "../../packages/domain/src/index.ts";
import type { EvidenceItemHistory, EvidenceRevision, MetricSample } from "../../packages/domain/src/index.ts";

// AF-57: "Share of evidence items a recruiter had to correct. Target
// >= 98% precision on live pilots (99% on the locked offline eval)."

function revision(evidenceOutcomeId: string, supersedes?: string): EvidenceRevision {
  return {
    evidenceOutcomeId,
    outcome: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "not_found",
      organizationId: "11111111-1111-4111-8111-111111111111",
      candidateId: "22222222-2222-4222-8222-222222222222",
      criterionId: "python_production"
    },
    recordedAt: "2026-08-29T12:00:00.000Z",
    ...(supersedes === undefined ? {} : { supersedesEvidenceOutcomeId: supersedes, correctedByUserId: "u", correctionReason: "wrong" })
  };
}

function clean(itemId: string, reviewed = true): EvidenceItemHistory {
  return { itemId, revisions: [revision(itemId)], reviewed };
}

function corrected(itemId: string, times = 1): EvidenceItemHistory {
  const revisions = [revision(itemId)];
  for (let index = 0; index < times; index += 1) {
    revisions.push(revision(`${itemId}-fix-${index}`, index === 0 ? itemId : `${itemId}-fix-${index - 1}`));
  }
  return { itemId, revisions, reviewed: true };
}

function codes(sample: MetricSample): readonly string[] {
  return sample.limitations.map((limitation) => limitation.code);
}

test("precision is the share of reviewed items that needed no correction", () => {
  const result = summarizeEvidencePrecision([clean("a"), clean("b"), clean("c"), corrected("d")]);
  assert.equal(result.precision, 0.75);
  assert.equal(result.reviewedItems, 4);
  assert.equal(result.correctedItems, 1);
});

test("items nobody looked at are excluded from the denominator", () => {
  // The whole ticket. Measured over everything produced, precision rises
  // by generating more evidence nobody reads -- the metric would improve
  // fastest when the product was working least.
  const result = summarizeEvidencePrecision([clean("a"), corrected("b"), clean("c", false), clean("d", false)]);
  assert.equal(result.reviewedItems, 2);
  assert.equal(result.producedItems, 4);
  assert.equal(result.precision, 0.5, "not 0.75, which is what counting the unread pile would give");
});

test("an unread backlog surfaces as an incomplete population without anyone remembering to say so", () => {
  const result = summarizeEvidencePrecision([clean("a"), clean("b", false)]);
  const sample = describeEvidencePrecision(result, "live_pilot", 1);
  assert.ok(codes(sample).includes("population_incomplete"));
  assert.equal(sample.sampleSize, 1);
  assert.equal(sample.population, 2);
});

test("an item corrected three times is one imprecise item, not three", () => {
  // Counting correction events would let a single stubborn item push the
  // rate below any target on its own, while the number kept the name
  // "share of items".
  const result = summarizeEvidencePrecision([clean("a"), clean("b"), clean("c"), corrected("d", 3)]);
  assert.equal(result.correctedItems, 1);
  assert.equal(result.precision, 0.75);
  assert.equal(result.correctionEvents, 3, "reported separately, because three is a worse story than one");
});

test("an empty denominator reports null, never perfect precision", () => {
  // What a pilot that has not started yet would otherwise report, and the
  // single most quotable wrong number this metric could produce.
  assert.equal(summarizeEvidencePrecision([]).precision, null);
  assert.equal(summarizeEvidencePrecision([clean("a", false)]).precision, null);
});

test("a corrected item marked unreviewed is contradictory input and throws", () => {
  // A correction is a human act, so the item was examined by definition.
  // Silently flipping the flag would hide a bug in whatever computed it,
  // and that bug moves the denominator.
  const contradictory: EvidenceItemHistory = { ...corrected("a"), reviewed: false };
  assert.throws(() => summarizeEvidencePrecision([contradictory]), /correction\(s\) but is marked unreviewed/);
});

test("two histories for one item throws rather than double-counting", () => {
  assert.throws(
    () => summarizeEvidencePrecision([clean("a"), corrected("a")]),
    /two histories for item a/
  );
});

test("live pilot and locked offline eval are separate metrics, never pooled", () => {
  // The ticket sets two targets, which only means anything if they are two
  // populations. Pooling lets a large clean offline eval mask live-pilot
  // errors -- and the offline set is the one that can be grown cheaply.
  const result = summarizeEvidencePrecision([clean("a"), corrected("b")]);
  assert.equal(describeEvidencePrecision(result, "live_pilot", 1).metric, "evidence_precision_live_pilot");
  assert.equal(
    describeEvidencePrecision(result, "locked_offline_eval", 1).metric,
    "evidence_precision_locked_offline_eval"
  );
});

test("a precision figure below the minimum sample is suppressed", () => {
  const result = summarizeEvidencePrecision([clean("a"), clean("b")]);
  const sample = describeEvidencePrecision(result, "live_pilot", 100);
  assert.equal(sample.value, null, "a 98% precision claim must not be reportable off two items");
  assert.ok(codes(sample).includes("below_minimum_sample"));
});

test("the metric knows nothing about the 98/99% targets", () => {
  const result = summarizeEvidencePrecision([corrected("a")]);
  const sample = describeEvidencePrecision(result, "live_pilot", 1);
  assert.equal(sample.value, 0);
  assert.ok(!Object.keys(sample).some((key) => /target|pass|meets/i.test(key)));
});

test("a revision that supersedes nothing is the original, not a correction", () => {
  // Every item has at least one revision. If the original counted as a
  // correction, precision would be 0 everywhere.
  const result = summarizeEvidencePrecision([clean("a"), clean("b")]);
  assert.equal(result.correctedItems, 0);
  assert.equal(result.precision, 1);
});
