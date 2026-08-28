import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION, EVIDENCE_OUTCOME_KINDS } from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome, EvidenceOutcomeKind } from "../../packages/domain/src/index.ts";
import {
  buildApiError,
  evidenceOutcomeSchema,
  generateRequestId,
  parseEvidenceOutcome,
  safeParseEvidenceOutcome
} from "../../packages/contracts/src/index.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const citation = {
  document: "resume.txt",
  pageOrSection: "Experience",
  offset: 0,
  quote: "Built and maintained Python microservices processing 2M+ events/day."
};

const conflictingCitation = {
  document: "cover_letter.txt",
  pageOrSection: "Summary",
  offset: 12,
  quote: "Never worked with production Python."
};

/** One well-formed sample per kind, so "every kind parses" actually covers every kind. */
const samples: Record<EvidenceOutcomeKind, EvidenceOutcome> = {
  supported: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "supported",
    organizationId: ORG_ID,
    criterionId: "python_production",
    citation
  },
  partially_supported: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "partially_supported",
    organizationId: ORG_ID,
    criterionId: "python_production",
    citation
  },
  contradicted: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "contradicted",
    organizationId: ORG_ID,
    criterionId: "python_production",
    citation,
    conflictingCitation
  },
  unclear: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "unclear",
    organizationId: ORG_ID,
    criterionId: "python_production",
    citation
  },
  not_found: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "not_found",
    organizationId: ORG_ID,
    criterionId: "aws_certification"
  },
  processing: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "processing",
    organizationId: ORG_ID,
    criterionId: "aws_certification"
  },
  retrying: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "retrying",
    organizationId: ORG_ID,
    criterionId: "python_production",
    attempt: 1,
    maxAttempts: 3
  },
  extraction_error: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    organizationId: ORG_ID,
    criterionId: "python_production",
    errorCode: "provider_unavailable",
    message: "AI provider returned 503 after all retries.",
    retryable: true
  },
  citation_invalid: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    organizationId: ORG_ID,
    criterionId: "python_production",
    reason: "quote not found verbatim in source",
    rejectedCitation: citation
  },
  invalid_source: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "invalid_source",
    organizationId: ORG_ID,
    criterionId: "python_production",
    reason: "document was empty"
  },
  unsupported_file: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "unsupported_file",
    organizationId: ORG_ID,
    criterionId: "python_production",
    reason: "format not supported"
  },
  quarantined: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "quarantined",
    organizationId: ORG_ID,
    criterionId: "python_production",
    quarantineClass: "corrupt",
    reason: "archive failed integrity check",
    operatorActionRequired: true
  },
  failed: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "failed",
    organizationId: ORG_ID,
    criterionId: "python_production",
    errorCode: "provider_unavailable",
    message: "AI provider returned 503 after all retries.",
    retryable: false
  }
};

test("a well-formed payload for every kind parses successfully", () => {
  for (const kind of EVIDENCE_OUTCOME_KINDS) {
    assert.equal(parseEvidenceOutcome(samples[kind]).kind, kind);
  }
});

test("rejects an unknown property on an otherwise-valid payload", () => {
  const result = safeParseEvidenceOutcome({
    ...samples.supported,
    matchStrength: 0.87 // POL-003: no scoring field should ever slip through
  });
  assert.equal(result.success, false);
});

test("not_found cannot carry a citation (states cannot collapse into each other)", () => {
  const result = safeParseEvidenceOutcome({ ...samples.not_found, citation });
  assert.equal(result.success, false);
});

test("supported requires a citation and is rejected without one", () => {
  const withoutCitation = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "supported" as const,
    organizationId: ORG_ID,
    criterionId: "python_production"
  };
  const result = safeParseEvidenceOutcome(withoutCitation);
  assert.equal(result.success, false);
});

test("failed and quarantined are structurally distinct even though both are terminal errors", () => {
  assert.equal(safeParseEvidenceOutcome({ ...samples.failed, kind: "quarantined" }).success, false);
  assert.equal(safeParseEvidenceOutcome({ ...samples.quarantined, kind: "failed" }).success, false);
});

test("every record is pinned to CONTRACT_SCHEMA_VERSION; a stale version is rejected", () => {
  const result = safeParseEvidenceOutcome({ ...samples.supported, schemaVersion: "0.9.0" });
  assert.equal(result.success, false);
});

test("an unrecognized kind matches no branch of the discriminated union", () => {
  const result = evidenceOutcomeSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "recommended_outcome",
    organizationId: ORG_ID,
    criterionId: "python_production"
  });
  assert.equal(result.success, false);
});

test("every outcome requires organizationId; a payload missing it is rejected", () => {
  for (const kind of EVIDENCE_OUTCOME_KINDS) {
    const { organizationId, ...withoutOrg } = samples[kind];
    assert.equal(organizationId, ORG_ID);
    assert.equal(safeParseEvidenceOutcome(withoutOrg).success, false, `expected ${kind} to require organizationId`);
  }
});

test("retrying rejects an attempt beyond maxAttempts", () => {
  const result = safeParseEvidenceOutcome({ ...samples.retrying, attempt: 4, maxAttempts: 3 });
  assert.equal(result.success, false);
});

test("retrying accepts attempt equal to maxAttempts (the last allowed try)", () => {
  const result = safeParseEvidenceOutcome({ ...samples.retrying, attempt: 3, maxAttempts: 3 });
  assert.equal(result.success, true);
});

test("quarantined requires operatorActionRequired to be true, not just any boolean", () => {
  const result = safeParseEvidenceOutcome({ ...samples.quarantined, operatorActionRequired: false });
  assert.equal(result.success, false);
});

test("failed requires retryable to be false; failed+retryable:true is what 'retrying' is for", () => {
  const result = safeParseEvidenceOutcome({ ...samples.failed, retryable: true });
  assert.equal(result.success, false);
});

test("contradicted requires citations for both sides of the conflict", () => {
  const withoutSecondCitation = {
    schemaVersion: samples.contradicted.schemaVersion,
    kind: samples.contradicted.kind,
    organizationId: samples.contradicted.organizationId,
    criterionId: samples.contradicted.criterionId,
    citation: samples.contradicted.citation
  };
  assert.equal(safeParseEvidenceOutcome(withoutSecondCitation).success, false);
});

test("citation_invalid preserves a structurally malformed rejected citation, not just a well-formed one", () => {
  const malformed = {
    ...samples.citation_invalid,
    rejectedCitation: { document: "resume.txt", offset: -5, quote: "" } // missing pageOrSection, bad offset, empty quote
  };
  const result = safeParseEvidenceOutcome(malformed);
  assert.equal(result.success, true);
});

test("buildApiError rejects a malformed requestId instead of producing a contract-invalid body", () => {
  assert.throws(() => buildApiError({ requestId: "not-a-real-request-id", code: "not_found", message: "x" }));
});

test("buildApiError rejects a blank message instead of producing a contract-invalid body", () => {
  assert.throws(() => buildApiError({ requestId: generateRequestId(), code: "not_found", message: "" }));
});

test("buildApiError accepts a real requestId and message, and details stays JSON-shaped", () => {
  const requestId = generateRequestId();
  const response = buildApiError({
    requestId,
    code: "invalid_request",
    message: "bad input",
    details: { field: "email", nested: { count: 2, tags: ["a", "b"], ok: true, missing: null } }
  });
  assert.equal(response.body.requestId, requestId);
  assert.deepEqual(response.body.error.details, {
    field: "email",
    nested: { count: 2, tags: ["a", "b"], ok: true, missing: null }
  });
});
