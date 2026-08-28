import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION, EVIDENCE_OUTCOME_KINDS } from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome, EvidenceOutcomeKind } from "../../packages/domain/src/index.ts";
import {
  outcomesForSchemaValidationFailure,
  parseEvidenceExtractionResponse,
  routeForReview
} from "../../packages/ai/src/index.ts";

const citation = { document: "d", pageOrSection: "p", offset: 0, quote: "q" };

/** One sample per kind, matching tests/unit/evidence-outcome-domain.test.ts. */
const samples: Record<EvidenceOutcomeKind, EvidenceOutcome> = {
  supported: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "supported", criterionId: "c", citation },
  partially_supported: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "partially_supported",
    criterionId: "c",
    citation
  },
  contradicted: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "contradicted", criterionId: "c", citation },
  unclear: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "unclear", criterionId: "c", citation },
  not_found: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId: "c" },
  processing: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "processing", criterionId: "c" },
  retrying: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "retrying", criterionId: "c", attempt: 1, maxAttempts: 3 },
  extraction_error: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    criterionId: "c",
    errorCode: "e",
    message: "m",
    retryable: true
  },
  citation_invalid: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    criterionId: "c",
    reason: "r",
    rejectedCitation: citation
  },
  invalid_source: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "invalid_source", criterionId: "c", reason: "r" },
  unsupported_file: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "unsupported_file",
    criterionId: "c",
    reason: "r"
  },
  quarantined: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "quarantined",
    criterionId: "c",
    quarantineClass: "malicious",
    reason: "r",
    operatorActionRequired: true
  },
  failed: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "failed",
    criterionId: "c",
    errorCode: "e",
    message: "m",
    retryable: false
  }
};

const EXPECTED_NEEDS_REVIEW: Record<EvidenceOutcomeKind, boolean> = {
  supported: false,
  partially_supported: false,
  not_found: false,
  processing: false,
  retrying: false,
  unclear: true,
  contradicted: true,
  citation_invalid: true,
  extraction_error: true,
  invalid_source: true,
  unsupported_file: true,
  quarantined: true,
  failed: true
};

test("every kind routes to the expected review decision, with no kind left unhandled", () => {
  assert.deepEqual(new Set(EVIDENCE_OUTCOME_KINDS), new Set(Object.keys(samples)));
  for (const kind of EVIDENCE_OUTCOME_KINDS) {
    const routing = routeForReview(samples[kind]);
    assert.equal(routing.needsReview, EXPECTED_NEEDS_REVIEW[kind], `unexpected routing for ${kind}`);
  }
});

test("every needs-review routing carries a non-empty, specific reason", () => {
  for (const kind of EVIDENCE_OUTCOME_KINDS) {
    if (!EXPECTED_NEEDS_REVIEW[kind]) {
      continue;
    }
    const routing = routeForReview(samples[kind]);
    assert.equal(routing.needsReview, true);
    if (routing.needsReview) {
      assert.ok(routing.reason.length > 0, `${kind} should carry a reason`);
    }
  }
});

test("the four categories the ticket names explicitly map to review", () => {
  assert.equal(routeForReview(samples.citation_invalid).needsReview, true);
  assert.equal(routeForReview(samples.contradicted).needsReview, true);
  assert.equal(
    routeForReview(samples.supported, { injectionIndicatorDetected: true }).needsReview,
    true
  );
  const parsed = parseEvidenceExtractionResponse({ items: "not-an-array" });
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  const schemaRouting = routeForReview(parsed.failure);
  assert.equal(schemaRouting.needsReview, true);
  if (schemaRouting.needsReview) {
    assert.match(schemaRouting.reason, /schema validation/i);
  }
});

test("a confident, validated result does not get the special review flag", () => {
  assert.equal(routeForReview(samples.supported).needsReview, false);
  assert.equal(routeForReview(samples.not_found).needsReview, false);
});

test("a schema-invalid model response is itself a review subject", () => {
  const parsed = parseEvidenceExtractionResponse({
    items: [{ criterion_id: "c", state: "supported" }]
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  const routing = routeForReview(parsed.failure);
  assert.equal(routing.needsReview, true);
  if (routing.needsReview) {
    assert.match(routing.reason, /failed schema validation/i);
  }
});

test("schema validation failure converts into one persistable extraction_error per criterion", () => {
  const parsed = parseEvidenceExtractionResponse({ not: "the schema" });
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  const outcomes = outcomesForSchemaValidationFailure(["python", "aws"], parsed.failure);
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.kind, "extraction_error");
    if (outcome.kind === "extraction_error") {
      assert.equal(outcome.errorCode, "schema_validation_failed");
    }
    const routing = routeForReview(outcome);
    assert.equal(routing.needsReview, true);
  }
});

test("an injection signal routes a later supported or not_found result to review", () => {
  const supported = routeForReview(samples.supported, { injectionIndicatorDetected: true });
  assert.equal(supported.needsReview, true);
  if (supported.needsReview) {
    assert.match(supported.reason, /injection indicator/i);
  }
  const notFound = routeForReview(samples.not_found, { injectionIndicatorDetected: true });
  assert.equal(notFound.needsReview, true);
  if (notFound.needsReview) {
    assert.match(notFound.reason, /injection indicator/i);
  }
});

test("an injection signal keeps an already-flagged outcome in review", () => {
  const routing = routeForReview(samples.contradicted, { injectionIndicatorDetected: true });
  assert.equal(routing.needsReview, true);
  if (routing.needsReview) {
    assert.match(routing.reason, /conflict/i);
    assert.match(routing.reason, /injection indicator/i);
  }
});
