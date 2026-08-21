import { z } from "zod";

import { CONTRACT_SCHEMA_VERSION } from "@signal-audit/domain";
import type {
  CitationInvalidEvidence,
  ContradictedEvidence,
  DomainPort,
  EvidenceOutcome,
  ExtractionErrorEvidence,
  FailedEvidence,
  InvalidSourceEvidence,
  NotFoundEvidence,
  PartiallySupportedEvidence,
  ProcessingEvidence,
  QuarantinedEvidence,
  RetryingEvidence,
  SourceCitation,
  SupportedEvidence,
  UnclearEvidence,
  UnsupportedFileEvidence
} from "@signal-audit/domain";

/** Placeholder boundary shape; AF-13 owns real versioned runtime contracts. */
export interface BoundaryContract {
  readonly domain: DomainPort;
  readonly version: string;
}

// ---- AF-13: runtime validation for the versioned domain contracts ----
//
// Types alone don't reject an extra field on parsed JSON at runtime. Every
// schema below is built with z.strictObject so an unrecognized property
// (from a provider response, a stored record, or an API payload) fails
// validation instead of being silently accepted.

const schemaVersionSchema = z.literal(CONTRACT_SCHEMA_VERSION);

const sourceCitationSchema = z.strictObject({
  document: z.string().min(1),
  pageOrSection: z.string().min(1),
  offset: z.number().int().min(0),
  quote: z.string().min(1)
}) satisfies z.ZodType<SourceCitation>;

const supportedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("supported"),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<SupportedEvidence>;

const partiallySupportedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("partially_supported"),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<PartiallySupportedEvidence>;

const contradictedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("contradicted"),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<ContradictedEvidence>;

const unclearEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("unclear"),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<UnclearEvidence>;

const notFoundEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("not_found"),
  criterionId: z.string().min(1)
}) satisfies z.ZodType<NotFoundEvidence>;

const processingEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("processing"),
  criterionId: z.string().min(1)
}) satisfies z.ZodType<ProcessingEvidence>;

const retryingEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("retrying"),
  criterionId: z.string().min(1),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1)
}) satisfies z.ZodType<RetryingEvidence>;

const extractionErrorEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("extraction_error"),
  criterionId: z.string().min(1),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
}) satisfies z.ZodType<ExtractionErrorEvidence>;

const citationInvalidEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("citation_invalid"),
  criterionId: z.string().min(1),
  reason: z.string().min(1),
  rejectedCitation: sourceCitationSchema
}) satisfies z.ZodType<CitationInvalidEvidence>;

const invalidSourceEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("invalid_source"),
  criterionId: z.string().min(1),
  reason: z.string().min(1)
}) satisfies z.ZodType<InvalidSourceEvidence>;

const unsupportedFileEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("unsupported_file"),
  criterionId: z.string().min(1),
  reason: z.string().min(1)
}) satisfies z.ZodType<UnsupportedFileEvidence>;

const quarantinedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("quarantined"),
  criterionId: z.string().min(1),
  quarantineClass: z.enum(["malicious", "unsupported", "corrupt", "persistent_failure"]),
  reason: z.string().min(1),
  operatorActionRequired: z.boolean()
}) satisfies z.ZodType<QuarantinedEvidence>;

const failedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("failed"),
  criterionId: z.string().min(1),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
}) satisfies z.ZodType<FailedEvidence>;

/**
 * Runtime-validated, versioned contract for EvidenceOutcome. Discriminated
 * on `kind` so a payload can only ever match exactly one branch: it cannot
 * be "not_found" and also carry a citation, or be "failed" and also be
 * "quarantined". Reject-on-parse, not best-effort coercion.
 */
export const evidenceOutcomeSchema = z.discriminatedUnion("kind", [
  supportedEvidenceSchema,
  partiallySupportedEvidenceSchema,
  contradictedEvidenceSchema,
  unclearEvidenceSchema,
  notFoundEvidenceSchema,
  processingEvidenceSchema,
  retryingEvidenceSchema,
  extractionErrorEvidenceSchema,
  citationInvalidEvidenceSchema,
  invalidSourceEvidenceSchema,
  unsupportedFileEvidenceSchema,
  quarantinedEvidenceSchema,
  failedEvidenceSchema
]) satisfies z.ZodType<EvidenceOutcome>;

/** Throws a ZodError on an invalid or unrecognized-shape payload. */
export function parseEvidenceOutcome(value: unknown): EvidenceOutcome {
  return evidenceOutcomeSchema.parse(value);
}

/** Never throws; inspect `.success` before using `.data`. */
export function safeParseEvidenceOutcome(value: unknown) {
  return evidenceOutcomeSchema.safeParse(value);
}
