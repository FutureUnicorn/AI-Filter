import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import {
  evidenceOutcomeSchema,
  parseEvidenceOutcome,
  safeParseEvidenceOutcome
} from "../../packages/contracts/src/index.ts";

const citation = {
  document: "resume.txt",
  pageOrSection: "Experience",
  offset: 0,
  quote: "Built and maintained Python microservices processing 2M+ events/day."
};

const supported = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  kind: "supported" as const,
  criterionId: "python_production",
  citation
};

const notFound = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  kind: "not_found" as const,
  criterionId: "aws_certification"
};

const failed = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  kind: "failed" as const,
  criterionId: "python_production",
  errorCode: "provider_unavailable",
  message: "AI provider returned 503 after all retries.",
  retryable: false
};

const quarantined = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  kind: "quarantined" as const,
  criterionId: "python_production",
  quarantineClass: "corrupt" as const,
  reason: "archive failed integrity check",
  operatorActionRequired: true
};

test("a well-formed payload for every kind parses successfully", () => {
  for (const sample of [supported, notFound, failed, quarantined]) {
    assert.equal(parseEvidenceOutcome(sample).kind, sample.kind);
  }
});

test("rejects an unknown property on an otherwise-valid payload", () => {
  const result = safeParseEvidenceOutcome({
    ...supported,
    matchStrength: 0.87 // POL-003: no scoring field should ever slip through
  });
  assert.equal(result.success, false);
});

test("not_found cannot carry a citation (states cannot collapse into each other)", () => {
  const result = safeParseEvidenceOutcome({ ...notFound, citation });
  assert.equal(result.success, false);
});

test("supported requires a citation and is rejected without one", () => {
  const withoutCitation = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "supported" as const,
    criterionId: "python_production"
  };
  const result = safeParseEvidenceOutcome(withoutCitation);
  assert.equal(result.success, false);
});

test("failed and quarantined are structurally distinct even though both are terminal errors", () => {
  assert.equal(safeParseEvidenceOutcome({ ...failed, kind: "quarantined" }).success, false);
  assert.equal(safeParseEvidenceOutcome({ ...quarantined, kind: "failed" }).success, false);
});

test("every record is pinned to CONTRACT_SCHEMA_VERSION; a stale version is rejected", () => {
  const result = safeParseEvidenceOutcome({ ...supported, schemaVersion: "0.9.0" });
  assert.equal(result.success, false);
});

test("an unrecognized kind matches no branch of the discriminated union", () => {
  const result = evidenceOutcomeSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "recommended_outcome",
    criterionId: "python_production"
  });
  assert.equal(result.success, false);
});
