import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  describeFailedDocumentRate,
  summarizeFailedDocuments,
  summarizeMetric
} from "../../packages/domain/src/index.ts";

const base = {
  metric: "failed_document_rate",
  value: 0.6,
  sampleSize: 10,
  population: 10,
  minimumSampleSize: 5
};

test("a sufficient sample reports its value and no limitations", () => {
  const s = summarizeMetric(base);
  assert.equal(s.value, 0.6);
  assert.equal(s.sampleSize, 10);
  assert.deepEqual(s.limitations, []);
  assert.equal(s.schemaVersion, CONTRACT_SCHEMA_VERSION);
});

test("a below-minimum sample suppresses the value rather than warning beside it", () => {
  // The point of the ticket: a warning next to a number gets dropped by
  // whatever renders it, and the number is what gets quoted. So the
  // number must not survive at all.
  const s = summarizeMetric({ ...base, sampleSize: 3, population: 3, minimumSampleSize: 5 });
  assert.equal(s.value, null);
  assert.equal(s.limitations.length, 1);
  assert.equal(s.limitations[0]?.code, "below_minimum_sample");
  assert.match(s.limitations[0]?.detail ?? "", /3 observations is below the minimum of 5/);
});

test("an empty sample says no_sample, not below_minimum_sample", () => {
  // Distinct claims: "nothing has resolved" is not "too few resolved".
  const s = summarizeMetric({ ...base, sampleSize: 0, population: 4 });
  assert.equal(s.value, null);
  assert.deepEqual(
    s.limitations.map((l) => l.code),
    ["no_sample", "population_incomplete"]
  );
});

test("an incomplete population is reported even when the value stands", () => {
  const s = summarizeMetric({ ...base, sampleSize: 6, population: 10 });
  assert.equal(s.value, 0.6, "6 >= minimum 5, so the value is still supported");
  assert.deepEqual(
    s.limitations.map((l) => l.code),
    ["population_incomplete"]
  );
  assert.match(s.limitations[0]?.detail ?? "", /4 of 10 in scope are not yet counted/);
});

test("a denominator larger than its population is rejected, not clamped", () => {
  assert.throws(
    () => summarizeMetric({ ...base, sampleSize: 11, population: 10 }),
    /sampleSize \(11\) exceeds population \(10\)/
  );
});

test("non-finite values and negative counts are rejected", () => {
  assert.throws(() => summarizeMetric({ ...base, value: Number.POSITIVE_INFINITY }), /must be finite or null/);
  assert.throws(() => summarizeMetric({ ...base, sampleSize: -1 }), /non-negative integer sampleSize/);
  assert.throws(() => summarizeMetric({ ...base, minimumSampleSize: 1.5 }), /non-negative integer minimumSampleSize/);
});

test("describeFailedDocumentRate carries AF-58's denominator, not its headline count", () => {
  // 3 failed of 5 resolved, with 2 still in flight out of 7 uploaded.
  const rate = summarizeFailedDocuments("org", "role", {
    uploaded: 7,
    quarantined: 1,
    rejected: 1,
    extractionEmpty: 1,
    extractionSucceeded: 2
  });
  const s = describeFailedDocumentRate(rate, 5);
  assert.equal(s.sampleSize, 5, "denominator is resolved outcomes, not uploaded documents");
  assert.equal(s.population, 7);
  assert.equal(s.value, 0.6);
  assert.deepEqual(
    s.limitations.map((l) => l.code),
    ["population_incomplete"],
    "the 2 in-flight documents are surfaced without the caller having to remember"
  );
});

test("a role whose documents have all yet to resolve reports nothing, not zero", () => {
  const rate = summarizeFailedDocuments("org", "role", {
    uploaded: 4,
    quarantined: 0,
    rejected: 0,
    extractionEmpty: 0,
    extractionSucceeded: 0
  });
  const s = describeFailedDocumentRate(rate, 5);
  assert.equal(s.value, null);
  assert.equal(s.sampleSize, 0);
  assert.equal(s.limitations[0]?.code, "no_sample");
});
