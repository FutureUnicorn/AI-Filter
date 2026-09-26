import assert from "node:assert/strict";
import test from "node:test";

import { metricSampleSchema } from "../../packages/contracts/src/index.ts";
import {
  describeFailedDocumentRate,
  summarizeFailedDocuments,
  summarizeMetric
} from "../../packages/domain/src/index.ts";

const supported = summarizeMetric({
  metric: "failed_document_rate",
  value: 0.6,
  sampleSize: 10,
  population: 10,
  minimumSampleSize: 5
});

test("summarizeMetric output satisfies the published contract", () => {
  const parsed = metricSampleSchema.safeParse(supported);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("a suppressed metric round-trips with a null value", () => {
  const suppressed = summarizeMetric({
    metric: "failed_document_rate",
    value: 0.6,
    sampleSize: 2,
    population: 9,
    minimumSampleSize: 5
  });
  assert.equal(suppressed.value, null);
  assert.equal(metricSampleSchema.safeParse(suppressed).success, true);
});

test("the contract refuses a value its own sample cannot support", () => {
  // The schema is the boundary, so it has to enforce this independently
  // rather than trusting summarizeMetric to have been used. Without this
  // refinement the wire format would happily carry exactly the thing the
  // domain function refuses to produce.
  assert.equal(metricSampleSchema.safeParse({ ...supported, sampleSize: 0, value: 0.6 }).success, false);
  assert.equal(
    metricSampleSchema.safeParse({ ...supported, sampleSize: 2, minimumSampleSize: 5, value: 0.6 }).success,
    false
  );
  // ... but the same shape with the value withheld is fine.
  assert.equal(
    metricSampleSchema.safeParse({ ...supported, sampleSize: 2, minimumSampleSize: 5, value: null }).success,
    true
  );
});

test("the contract refuses a denominator larger than its population", () => {
  assert.equal(metricSampleSchema.safeParse({ ...supported, sampleSize: 11, population: 10 }).success, false);
});

test("an unknown limitation code is refused", () => {
  const parsed = metricSampleSchema.safeParse({
    ...supported,
    limitations: [{ code: "vibes", detail: "seems fine" }]
  });
  assert.equal(parsed.success, false);
});

test("AF-58's rate crosses the boundary with its sample size intact", () => {
  const rate = summarizeFailedDocuments("11111111-1111-4111-8111-111111111111", "role", {
    uploaded: 7,
    quarantined: 1,
    rejected: 1,
    extractionEmpty: 1,
    extractionSucceeded: 2
  });
  const parsed = metricSampleSchema.safeParse(describeFailedDocumentRate(rate, 5));
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data?.sampleSize, 5);
  assert.equal(parsed.data?.population, 7);
});
