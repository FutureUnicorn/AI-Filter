import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  describeEvidencePrecision,
  summarizeEvidencePrecision
} from "../../packages/domain/src/index.ts";
import type {
  EvidenceExaminationSource,
  EvidenceItemHistory,
  EvidenceRevision,
  MetricSample
} from "../../packages/domain/src/index.ts";

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

// An uncorrected item has no item-level record of anyone reading it, so
// candidate_decision is the strongest thing a live pilot can say about
// it. That is the default here because it is the default in the data.
function clean(
  itemId: string,
  examinedVia: EvidenceExaminationSource = "candidate_decision"
): EvidenceItemHistory {
  return { itemId, revisions: [revision(itemId)], examinedVia };
}

function corrected(itemId: string, times = 1): EvidenceItemHistory {
  const revisions = [revision(itemId)];
  for (let index = 0; index < times; index += 1) {
    revisions.push(revision(`${itemId}-fix-${index}`, index === 0 ? itemId : `${itemId}-fix-${index - 1}`));
  }
  return { itemId, revisions, examinedVia: "item_correction" };
}

function codes(sample: MetricSample): readonly string[] {
  return sample.limitations.map((limitation) => limitation.code);
}

test("precision is the share of examined items that needed no correction", () => {
  const result = summarizeEvidencePrecision([clean("a"), clean("b"), clean("c"), corrected("d")]);
  assert.equal(result.precision, 0.75);
  assert.equal(result.examinedItems, 4);
  assert.equal(result.correctedItems, 1);
});

test("items nobody looked at are excluded from the denominator", () => {
  // The whole ticket. Measured over everything produced, precision rises
  // by generating more evidence nobody reads -- the metric would improve
  // fastest when the product was working least.
  const result = summarizeEvidencePrecision([
    clean("a"),
    corrected("b"),
    clean("c", "not_examined"),
    clean("d", "not_examined")
  ]);
  assert.equal(result.examinedItems, 2);
  assert.equal(result.producedItems, 4);
  assert.equal(result.precision, 0.5, "not 0.75, which is what counting the unread pile would give");
});

test("an unread backlog surfaces as an incomplete population without anyone remembering to say so", () => {
  const result = summarizeEvidencePrecision([clean("a"), clean("b", "not_examined")]);
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
  assert.equal(summarizeEvidencePrecision([clean("a", "not_examined")]).precision, null);
});

test("a corrected item that claims a weaker examination record is contradictory input and throws", () => {
  // A correction is a human act, so the item was examined by definition.
  // Accepting a weaker attribution would hide a bug in whatever computed
  // it, and that bug moves the denominator.
  for (const examinedVia of ["not_examined", "candidate_decision", "offline_annotation"] as const) {
    assert.throws(
      () => summarizeEvidencePrecision([{ ...corrected("a"), examinedVia }]),
      new RegExp(`item a has 1 correction\\(s\\).*claims examinedVia ${examinedVia}`, "s"),
      `${examinedVia} must not be accepted for an item whose revisions carry a correction`
    );
  }
});

test("an uncorrected item cannot claim item-level proof that its revisions do not show", () => {
  // The one remaining way to assert item-level examination for an item no
  // record covers. Without this check a caller marks clean items
  // item_correction, the inference caveat disappears, and the precision
  // figure looks auditable while resting on nothing.
  assert.throws(
    () => summarizeEvidencePrecision([{ ...clean("a"), examinedVia: "item_correction" }]),
    /item a claims examinedVia item_correction but none of its revisions supersedes another/
  );
});

test("two histories for one item throws rather than double-counting", () => {
  assert.throws(
    () => summarizeEvidencePrecision([clean("a"), corrected("a")]),
    /two histories for item a/
  );
});

test("a denominator resting on candidate-level decisions says so in a code, not a comment", () => {
  // Nothing in this stack records that a person read a given evidence
  // item: decisions, audit samples and timing spans are all per
  // application. The number is still reported, because the only
  // item-level record is a correction and a denominator of corrected
  // items would report 0 for ever. What travels with it is what it rests
  // on. Consumers branch on codes; a doc comment reaches nobody.
  const result = summarizeEvidencePrecision([clean("a"), clean("b"), clean("c"), corrected("d")]);
  assert.equal(result.inferredExaminations, 3);
  const sample = describeEvidencePrecision(result, "live_pilot", 1);
  assert.ok(codes(sample).includes("examination_inferred"));
  const limitation = sample.limitations.find((entry) => entry.code === "examination_inferred");
  assert.match(limitation?.detail ?? "", /3 of 4 item\(s\)/, "the caveat has to carry the numbers involved");
  assert.equal(sample.value, 0.75, "declared, not suppressed");
});

test("the inference caveat is attached even when the value is suppressed", () => {
  // It describes how the denominator was built, not how big it is. A
  // caveat that appeared and vanished with sample size would read as
  // being about sample size. Same reasoning as AF-55's baseline caveat.
  const result = summarizeEvidencePrecision([clean("a"), clean("b")]);
  const sample = describeEvidencePrecision(result, "live_pilot", 100);
  assert.equal(sample.value, null);
  assert.ok(codes(sample).includes("below_minimum_sample"));
  assert.ok(codes(sample).includes("examination_inferred"));
});

test("a denominator of item-level records carries no inference caveat", () => {
  const live = summarizeEvidencePrecision([corrected("a"), corrected("b")]);
  assert.equal(live.inferredExaminations, 0);
  assert.ok(!codes(describeEvidencePrecision(live, "live_pilot", 1)).includes("examination_inferred"));

  // The locked eval records an expected kind per criterion, so every item
  // in it was adjudicated one at a time. That is why the 99% target is
  // askable of that dataset and the 98% one is not askable the same way.
  const offline = summarizeEvidencePrecision([clean("a", "offline_annotation"), corrected("b")]);
  assert.equal(offline.annotatedExaminations, 1);
  assert.ok(!codes(describeEvidencePrecision(offline, "locked_offline_eval", 1)).includes("examination_inferred"));
});

test("neither dataset can be reported out of the other one's examination records", () => {
  // The dataset argument stops the two sharing a metric name. It does not
  // stop a denominator of live-pilot items being reported under the
  // offline name, which pools them just as effectively.
  const recruiterExamined = summarizeEvidencePrecision([clean("a"), clean("b")]);
  assert.throws(
    () => describeEvidencePrecision(recruiterExamined, "locked_offline_eval", 1),
    /2 item\(s\) examined only via a candidate decision cannot be reported as locked_offline_eval/
  );

  const annotatorExamined = summarizeEvidencePrecision([clean("a", "offline_annotation")]);
  assert.throws(
    () => describeEvidencePrecision(annotatorExamined, "live_pilot", 1),
    /1 item\(s\) examined by a locked-eval annotator cannot be reported as live_pilot/
  );
});

test("live pilot and locked offline eval are separate metrics, never pooled", () => {
  // The ticket sets two targets, which only means anything if they are two
  // populations. Pooling lets a large clean offline eval mask live-pilot
  // errors -- and the offline set is the one that can be grown cheaply.
  const live = summarizeEvidencePrecision([clean("a"), corrected("b")]);
  const offline = summarizeEvidencePrecision([clean("a", "offline_annotation"), corrected("b")]);
  assert.equal(describeEvidencePrecision(live, "live_pilot", 1).metric, "evidence_precision_live_pilot");
  assert.equal(
    describeEvidencePrecision(offline, "locked_offline_eval", 1).metric,
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
