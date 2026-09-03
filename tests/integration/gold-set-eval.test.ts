import assert from "node:assert/strict";
import test from "node:test";

import goldSet from "../../evals/datasets/gold-set-v1.json" with { type: "json" };
import { GOLD_SET_V1_THRESHOLDS, checkGoldSetThresholds, scoreGoldSet } from "../../packages/ai/src/index.ts";
import type { EvidenceExtractionItem, GoldSetCase } from "../../packages/ai/src/index.ts";

// This is the CI gate AF-43 asks for: it runs the real deterministic
// pipeline (mapRubricToEvidence -> validateCitation -> routeForReview)
// against the checked-in gold set and fails the build on regression.
// No model/provider credentials are used or required.

const cases = goldSet.cases as unknown as readonly GoldSetCase[];

// Replaces an earlier "at least one locked and one unlocked case" check.
// That assertion only proved a boolean took both values, and the boolean
// itself was removed in review (#26) because a flag sitting in the same
// checked-in file as the expected labels cannot hold anything back. What
// actually makes this suite non-trivial is spread: a gate whose cases all
// expect the same kind, or which never expects a rejection, passes while
// the pipeline is broken in every direction it does not look.
test("the gold set itself is non-trivial: it spans distinct kinds and includes a rejection", () => {
  const kinds = new Set(cases.flatMap((c) => Object.values(c.expectedKinds)));
  assert.ok(kinds.size >= 4, `expected at least 4 distinct expected kinds, got ${kinds.size}: ${[...kinds].join(", ")}`);
  assert.ok(
    kinds.has("citation_invalid"),
    "expected at least one case whose citation must be rejected, so the suite is not all happy-path"
  );
  assert.ok(
    cases.some((c) => c.expectedReviewCriterionIds.length > 0),
    "expected at least one case that must escalate to human review"
  );
});

test("gold-set v1 meets every regression threshold", () => {
  const score = scoreGoldSet(cases);
  const gate = checkGoldSetThresholds(score, GOLD_SET_V1_THRESHOLDS);
  assert.deepEqual(gate, { passed: true }, JSON.stringify({ score, gate }));
});

test("schema validity is scored across every simulated extraction item", () => {
  const score = scoreGoldSet(cases);
  assert.equal(score.schemaValidityRate, 1);
  assert.equal(score.totalCases, cases.length);
});

test("a regressed pipeline is actually caught: an uncaught hallucination fails citingRecall", () => {
  const brokenCase: GoldSetCase = {
    caseId: "regression-fixture",
    sourceText: "Built and maintained Python microservices processing 2M+ events/day.",
    rubricCriterionIds: ["postgres_experience"],
    simulatedExtraction: [
      {
        criterion_id: "postgres_experience",
        state: "supported",
        quote: "Designed PostgreSQL schemas for the core transactional workload.",
        source: { document: "resume.txt", page_or_section: "Experience", offset: 0 }
      }
    ],
    // Deliberately wrong ground truth, simulating "citation validation was
    // skipped/broken and let the hallucination through as supported".
    expectedKinds: { postgres_experience: "supported" },
    expectedReviewCriterionIds: []
  };
  const score = scoreGoldSet([brokenCase]);
  // The real validateCitation still runs and correctly produces
  // citation_invalid; comparing that against the (deliberately wrong)
  // "supported" expectation is what should show up as a scoring miss.
  assert.equal(score.outcomeAccuracy, 0);
  // citation_invalid is not a citing kind, so this is exactly the
  // "expected a citing kind, got a non-citing kind" false negative:
  // citingRecall correctly drops to 0. citingPrecision, by contrast,
  // stays at its vacuous 1 fallback here (no citing kind was ever
  // actually produced, so there is nothing to be imprecise about) --
  // asserting both pins down which metric this fixture actually proves.
  assert.equal(score.citingRecall, 0);
  assert.equal(score.citingPrecision, 1);
});

test("a malformed simulatedExtraction item lowers schemaValidityRate instead of crashing the eval", () => {
  // Real fixture data is loaded from JSON and force-cast (see `goldSet.cases
  // as unknown as readonly GoldSetCase[]` above), so a hand-authoring typo
  // can put an out-of-union `state` value into the array at runtime even
  // though the type says it can't happen -- this simulates exactly that.
  const malformedItem = {
    criterion_id: "postgres_experience",
    state: "hallucinated_state",
    quote: "",
    source: { document: "resume.txt", page_or_section: "Experience", offset: 0 }
  } as unknown as EvidenceExtractionItem;
  const caseWithBadItem: GoldSetCase = {
    caseId: "malformed-item-fixture",
    sourceText: "Built and maintained Python microservices processing 2M+ events/day.",
    rubricCriterionIds: ["postgres_experience"],
    simulatedExtraction: [malformedItem],
    expectedKinds: { postgres_experience: "supported" },
    expectedReviewCriterionIds: []
  };

  const score = scoreGoldSet([caseWithBadItem]);

  assert.equal(score.schemaValidityRate, 0);
  // The invalid item is excluded before mapping, not passed through: the
  // criterion is reported as omitted (a real, scoreable miss) rather than
  // crashing the whole eval run.
  assert.equal(score.outcomeAccuracy, 0);
});

test("a typo'd expectedKinds key throws instead of silently scoring a perfect match", () => {
  const typoCase: GoldSetCase = {
    caseId: "typo-fixture",
    sourceText: "Built and maintained Python microservices processing 2M+ events/day.",
    rubricCriterionIds: ["postgres_experience"],
    simulatedExtraction: [],
    expectedKinds: { psotgres_experience: "not_found" },
    expectedReviewCriterionIds: []
  };
  assert.throws(() => scoreGoldSet([typoCase]), /psotgres_experience/);
});

test("a typo'd expectedReviewCriterionIds entry throws instead of vanishing into a false-perfect escalationRecall", () => {
  const typoCase: GoldSetCase = {
    caseId: "typo-review-fixture",
    sourceText: "Built and maintained Python microservices processing 2M+ events/day.",
    rubricCriterionIds: ["postgres_experience"],
    simulatedExtraction: [],
    expectedKinds: {},
    expectedReviewCriterionIds: ["psotgres_experience"]
  };
  assert.throws(() => scoreGoldSet([typoCase]), /psotgres_experience/);
});

test("over-escalation is caught: routing a clean case to review fails escalationPrecision", () => {
  // The bug escalationPrecision exists to catch. Before it, the harness
  // only ever asked "was every expected-review criterion flagged?", so a
  // routing regression that sent EVERYTHING to human review scored a
  // perfect 1.0 on escalationRecall and left every other metric
  // untouched -- the gate passed while the product shipped a review
  // queue containing all of its own clean results.
  //
  // This fixture stands in for that regression: the pipeline genuinely
  // routes `unclear` to review (correctly, per routeOutcomeForReview),
  // but the ground truth says this criterion should not have needed a
  // human. That is precisely the shape of an over-escalation.
  const overEscalatingCase: GoldSetCase = {
    caseId: "over-escalation-fixture",
    sourceText: "Familiar with backend systems including some Python tooling.",
    rubricCriterionIds: ["python_production"],
    simulatedExtraction: [
      {
        criterion_id: "python_production",
        state: "unclear",
        quote: "Familiar with backend systems including some Python tooling.",
        source: { document: "resume.txt", page_or_section: "Skills", offset: 0 }
      }
    ],
    expectedKinds: { python_production: "unclear" },
    expectedReviewCriterionIds: []
  };

  const score = scoreGoldSet([overEscalatingCase]);

  // Recall is blind here: nothing was expected to escalate, so its
  // empty-denominator fallback reports a vacuous 1.0. That is the exact
  // blind spot -- asserting it pins down that recall alone could not
  // have failed this build.
  assert.equal(score.escalationRecall, 1);
  assert.equal(score.escalationPrecision, 0);

  // And the gate has to actually act on it, naming the metric.
  const gate = checkGoldSetThresholds(score, GOLD_SET_V1_THRESHOLDS);
  assert.equal(gate.passed, false);
  if (!gate.passed) {
    assert.ok(
      gate.failures.some((failure) => failure.includes("escalationPrecision")),
      JSON.stringify({ score, gate })
    );
  }
});

test("escalationPrecision only counts genuine escalations, so a correctly-routed case still scores 1", () => {
  // The negative control for the test above: same `unclear` outcome,
  // but now the ground truth agrees it needs a human. Without this,
  // "escalationPrecision drops to 0" could just as easily mean the
  // metric is wired to a constant.
  const correctlyEscalatingCase: GoldSetCase = {
    caseId: "correct-escalation-fixture",
    sourceText: "Familiar with backend systems including some Python tooling.",
    rubricCriterionIds: ["python_production"],
    simulatedExtraction: [
      {
        criterion_id: "python_production",
        state: "unclear",
        quote: "Familiar with backend systems including some Python tooling.",
        source: { document: "resume.txt", page_or_section: "Skills", offset: 0 }
      }
    ],
    expectedKinds: { python_production: "unclear" },
    expectedReviewCriterionIds: ["python_production"]
  };

  const score = scoreGoldSet([correctlyEscalatingCase]);
  assert.equal(score.escalationRecall, 1);
  assert.equal(score.escalationPrecision, 1);
  assert.deepEqual(checkGoldSetThresholds(score, GOLD_SET_V1_THRESHOLDS), { passed: true });
});

test("checkGoldSetThresholds reports which specific metric regressed, not just pass/fail", () => {
  const failingScore = {
    totalCases: 1,
    schemaValidityRate: 1,
    outcomeAccuracy: 0.5,
    citingPrecision: 1,
    citingRecall: 1,
    escalationRecall: 1,
    escalationPrecision: 1
  };
  const gate = checkGoldSetThresholds(failingScore, GOLD_SET_V1_THRESHOLDS);
  assert.equal(gate.passed, false);
  if (!gate.passed) {
    assert.equal(gate.failures.length, 1);
    assert.match(gate.failures[0] ?? "", /outcomeAccuracy/);
  }
});
