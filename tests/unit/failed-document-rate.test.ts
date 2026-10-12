import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION, summarizeFailedDocuments } from "../../packages/domain/src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const ROLE = "22222222-2222-4222-8222-222222222222";

const summarize = (counts: Parameters<typeof summarizeFailedDocuments>[2]) =>
  summarizeFailedDocuments(ORG, ROLE, counts);

test("failedRate is null, not 0, when nothing has resolved yet", () => {
  // The distinction the whole metric turns on: a role whose documents are
  // all still in flight has no failure rate. Reporting 0 would make an
  // untouched role indistinguishable from a perfectly healthy one.
  const result = summarize({
    uploaded: 5,
    quarantined: 0,
    rejected: 0,
    extractionEmpty: 0,
    extractionSucceeded: 0
  });
  assert.equal(result.failedRate, null);
  assert.equal(result.resolved, 0);
  assert.equal(result.inFlight, 5);
  assert.equal(result.schemaVersion, CONTRACT_SCHEMA_VERSION);
});

test("in-flight documents are excluded from the denominator", () => {
  // 2 failed, 2 succeeded, 6 still moving. The rate is 2/4, not 2/10:
  // otherwise it would drift downward on its own as the queue drains,
  // with no change in pipeline health.
  const result = summarize({
    uploaded: 10,
    quarantined: 1,
    rejected: 1,
    extractionEmpty: 0,
    extractionSucceeded: 2
  });
  assert.equal(result.failed, 2);
  assert.equal(result.resolved, 4);
  assert.equal(result.inFlight, 6);
  assert.equal(result.failedRate, 0.5);
});

test("an empty extraction counts as a failure, a partial one does not", () => {
  const result = summarize({
    uploaded: 4,
    quarantined: 0,
    rejected: 0,
    extractionEmpty: 1,
    extractionSucceeded: 3
  });
  assert.equal(result.failed, 1);
  assert.equal(result.extractionEmpty, 1);
  assert.equal(result.failedRate, 0.25);
});

test("all three failure modes are summed into `failed`", () => {
  const result = summarize({
    uploaded: 6,
    quarantined: 2,
    rejected: 1,
    extractionEmpty: 3,
    extractionSucceeded: 0
  });
  assert.equal(result.failed, 6);
  assert.equal(result.failedRate, 1);
  assert.equal(result.inFlight, 0);
});

test("counts that cannot describe one pipeline are rejected, not normalised", () => {
  // resolved > uploaded is a contradiction in the input. Clamping would
  // emit a rate <= 1 and a negative inFlight silently.
  assert.throws(
    () =>
      summarize({
        uploaded: 2,
        quarantined: 2,
        rejected: 2,
        extractionEmpty: 0,
        extractionSucceeded: 0
      }),
    /resolved \(4\) exceeds uploaded \(2\)/
  );
});

test("non-integer and negative counts are rejected", () => {
  for (const bad of [
    { uploaded: 1.5, quarantined: 0, rejected: 0, extractionEmpty: 0, extractionSucceeded: 0 },
    { uploaded: 1, quarantined: -1, rejected: 0, extractionEmpty: 0, extractionSucceeded: 0 },
    { uploaded: Number.NaN, quarantined: 0, rejected: 0, extractionEmpty: 0, extractionSucceeded: 0 }
  ]) {
    assert.throws(() => summarize(bad), /non-negative integer counts/);
  }
});
