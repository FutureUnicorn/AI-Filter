import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_OUTCOME_KINDS,
  assertUnreachableEvidenceOutcome,
  type EvidenceOutcome,
  type EvidenceOutcomeKind
} from "../../packages/domain/src/index.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "candidate_1";

/** One minimal sample per kind, used only to prove the switch below is exhaustive. */
const samples: Record<EvidenceOutcomeKind, EvidenceOutcome> = {
  supported: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "supported",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    citation: { document: "d", pageOrSection: "p", offset: 0, quote: "q" }
  },
  partially_supported: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "partially_supported",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    citation: { document: "d", pageOrSection: "p", offset: 0, quote: "q" }
  },
  contradicted: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "contradicted",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    citation: { document: "d", pageOrSection: "p", offset: 0, quote: "q" },
    conflictingCitation: { document: "d2", pageOrSection: "p2", offset: 10, quote: "q2" }
  },
  unclear: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "unclear",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    citation: { document: "d", pageOrSection: "p", offset: 0, quote: "q" }
  },
  not_found: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", organizationId: ORG_ID, candidateId: CANDIDATE_ID, criterionId: "c" },
  processing: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "processing",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c"
  },
  retrying: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "retrying",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    attempt: 1,
    maxAttempts: 3
  },
  extraction_error: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    errorCode: "e",
    message: "m",
    retryable: true
  },
  citation_invalid: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    reason: "r",
    rejectedCitation: { document: "d", pageOrSection: "p", offset: 0, quote: "q" }
  },
  invalid_source: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "invalid_source",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    reason: "r"
  },
  unsupported_file: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "unsupported_file",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    reason: "r"
  },
  quarantined: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "quarantined",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    quarantineClass: "corrupt",
    reason: "r",
    operatorActionRequired: true
  },
  failed: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "failed",
    organizationId: ORG_ID,
    candidateId: CANDIDATE_ID,
    criterionId: "c",
    errorCode: "e",
    message: "m",
    retryable: false
  }
};

/**
 * Compile-time exhaustiveness proof: if EvidenceOutcome ever grows a kind
 * without a case here, `pnpm typecheck` fails at this function instead of
 * letting the new kind silently fall through some unrelated call site.
 */
function describe(outcome: EvidenceOutcome): string {
  switch (outcome.kind) {
    case "supported":
    case "partially_supported":
    case "contradicted":
    case "unclear":
      return outcome.citation.quote;
    case "not_found":
    case "processing":
      return outcome.criterionId;
    case "retrying":
      return `attempt ${outcome.attempt}/${outcome.maxAttempts}`;
    case "extraction_error":
    case "failed":
      return outcome.errorCode;
    case "citation_invalid":
    case "invalid_source":
    case "unsupported_file":
      return outcome.reason;
    case "quarantined":
      return outcome.quarantineClass;
    default:
      return assertUnreachableEvidenceOutcome(outcome);
  }
}

test("EVIDENCE_OUTCOME_KINDS has no duplicates and matches the union's own kinds", () => {
  assert.equal(EVIDENCE_OUTCOME_KINDS.length, new Set(EVIDENCE_OUTCOME_KINDS).size);
  assert.deepEqual(new Set(EVIDENCE_OUTCOME_KINDS), new Set(Object.keys(samples)));
});

test("every kind is exhaustively describable", () => {
  for (const kind of EVIDENCE_OUTCOME_KINDS) {
    assert.ok(describe(samples[kind]).length > 0);
  }
});

test("assertUnreachableEvidenceOutcome throws instead of silently accepting an unknown kind", () => {
  assert.throws(() => assertUnreachableEvidenceOutcome("bogus" as never), /Unhandled EvidenceOutcome kind/);
});

test("CONTRACT_SCHEMA_VERSION is pinned", () => {
  assert.equal(CONTRACT_SCHEMA_VERSION, "1.0.0");
});
