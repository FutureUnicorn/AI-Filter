import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ALLOWED_FILE_TYPES,
  APPLICATION_EVIDENCE_STATES,
  CANDIDATE_DECISION_KINDS,
  APPLICATION_IMPORT_FIELDS,
  AUDIT_ACTIONS,
  CONTRACT_SCHEMA_VERSION,
  FILE_INTAKE_STATUSES,
  IMPORT_ROW_OUTCOMES,
  MAX_RUBRIC_CRITERIA,
  MEMBERSHIP_ROLES,
  METRIC_LIMITATION_CODES,
  REVIEW_TIME_BASELINE_SOURCES,
  MIN_RUBRIC_CRITERIA,
  ROLE_STATUSES,
  RUBRIC_STATUSES
} from "@signal-audit/domain";
import type { ContractSchemaVersion } from "@signal-audit/domain";
import type {
  Application,
  ApplicationQueueEntry,
  CandidateDecision,
  AuditEvent,
  CanonicalTextExtraction,
  CanonicalTextPage,
  CitationInvalidEvidence,
  ContradictedEvidence,
  CsvColumnMapping,
  DomainPort,
  EvidenceExtractionRun,
  EvidenceOutcome,
  ExtractionErrorEvidence,
  FailedDocumentRate,
  FailedEvidence,
  FileIntake,
  ImportRow,
  InvalidSourceEvidence,
  Membership,
  MetricLimitation,
  MetricSample,
  ReviewTimeBaseline,
  CandidateAdjudication,
  NotFoundEvidence,
  Organization,
  PartiallySupportedEvidence,
  ProcessingEvidence,
  QuarantinedEvidence,
  RetryingEvidence,
  Role,
  Rubric,
  RubricCriterion,
  SourceCitation,
  SupportedEvidence,
  UnclearEvidence,
  UnsupportedFileEvidence,
  User
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

// ---- AF-14: API error, request-ID, and idempotency conventions ----
//
// These are pure, framework-agnostic helpers: they take plain strings (an
// HTTP method, a header value) and return plain data, so both apps/web
// (Next.js Route Handlers) and apps/worker can adopt them without either
// depending on the other's HTTP framework. Nothing here is wired into an
// existing endpoint by this ticket; future endpoint tickets adopt it.

const REQUEST_ID_HEADER_NAME = "X-Request-Id";
const REQUEST_ID_PATTERN =
  /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RequestId = string;

/** Every response carries one of these; generate it once per request. */
export function generateRequestId(): RequestId {
  return `req_${randomUUID()}`;
}

export const requestIdSchema = z
  .string()
  .regex(REQUEST_ID_PATTERN, "must match req_<uuid>");

/** Standard header name a request ID is carried under, in and out. */
export const REQUEST_ID_HEADER = REQUEST_ID_HEADER_NAME;

/** Attach the request ID header without disturbing any other headers. */
export function withRequestId(headers: HeadersInit | undefined, requestId: RequestId): Headers {
  const merged = new Headers(headers);
  merged.set(REQUEST_ID_HEADER_NAME, requestId);
  return merged;
}

/** Closed, stable set of machine-readable error codes for the whole API surface. */
export const API_ERROR_CODES = [
  "invalid_request",
  "missing_idempotency_key",
  "idempotency_key_conflict",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
  "service_unavailable"
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  missing_idempotency_key: 400,
  idempotency_key_conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503
};

/** The one shape every error response on the API surface takes. */
export interface ApiErrorBody {
  readonly schemaVersion: ContractSchemaVersion;
  readonly requestId: RequestId;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: Record<string, unknown> | undefined;
  };
}

export const apiErrorBodySchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  requestId: requestIdSchema,
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional()
  })
}) satisfies z.ZodType<ApiErrorBody>;

export interface BuildApiErrorInput {
  readonly requestId: RequestId;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  readonly status: number;
  readonly body: ApiErrorBody;
}

/** Build a status + body pair; callers hand `body` to their own JSON response. */
export function buildApiError(input: BuildApiErrorInput): ApiErrorResponse {
  return {
    status: API_ERROR_STATUS[input.code],
    body: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: input.requestId,
      error: {
        code: input.code,
        message: input.message,
        ...(input.details === undefined ? {} : { details: input.details })
      }
    }
  };
}

export type IdempotencyKey = string;

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u, "must be 1-255 chars of letters, digits, '.', '_', '-'");

/** Methods that require an Idempotency-Key; GET/HEAD/OPTIONS never do. */
export const MUTATING_HTTP_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type MutatingHttpMethod = (typeof MUTATING_HTTP_METHODS)[number];

function isMutatingHttpMethod(method: string): method is MutatingHttpMethod {
  return (MUTATING_HTTP_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Explicit, non-collapsing outcomes for the idempotency check, in the same
 * spirit as EvidenceOutcome: "missing" and "invalid" are structurally
 * distinct from "present", not different values of one status string.
 */
export type IdempotencyRequirement =
  | { readonly required: false }
  | { readonly required: true; readonly outcome: "present"; readonly key: IdempotencyKey }
  | { readonly required: true; readonly outcome: "missing" }
  | { readonly required: true; readonly outcome: "invalid"; readonly reason: string };

export function checkIdempotencyRequirement(
  method: string,
  headerValue: string | null
): IdempotencyRequirement {
  if (!isMutatingHttpMethod(method)) {
    return { required: false };
  }
  if (headerValue === null || headerValue.length === 0) {
    return { required: true, outcome: "missing" };
  }
  const parsed = idempotencyKeySchema.safeParse(headerValue);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "invalid Idempotency-Key";
    return { required: true, outcome: "invalid", reason };
  }
  return { required: true, outcome: "present", key: parsed.data };
}

/** The ready-to-send ApiError for a failed idempotency check, or undefined if it passed. */
export function idempotencyErrorResponse(
  requirement: IdempotencyRequirement,
  requestId: RequestId
): ApiErrorResponse | undefined {
  if (!requirement.required || requirement.outcome === "present") {
    return undefined;
  }
  if (requirement.outcome === "missing") {
    return buildApiError({
      requestId,
      code: "missing_idempotency_key",
      message: "Mutating requests require an Idempotency-Key header."
    });
  }
  return buildApiError({
    requestId,
    code: "invalid_request",
    message: `Idempotency-Key header is invalid: ${requirement.reason}`
  });
}

// ---- AF-15: runtime validation for organization/user/membership ----
//
// users.email is stored lowercase (`CHECK (email = lower(email))`).
// z.email() accepts Recruiter@acme.test; this schema lowercases so the
// parsed value can be persisted without violating that constraint.

export const storedEmailSchema = z.email().toLowerCase();

export const organizationSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  organizationId: z.uuid(),
  name: z.string().min(1),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<Organization>;

export const userSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  userId: z.uuid(),
  email: storedEmailSchema,
  displayName: z.string().min(1),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<User>;

export const membershipSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  membershipId: z.uuid(),
  organizationId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(MEMBERSHIP_ROLES),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<Membership>;

// ---- AF-16: request shapes for invite-only magic-link authentication ----
//
// There is no signup schema: requestMagicLinkInputSchema only re-sends a
// login link to an email that must already have a membership, and
// createInviteInputSchema requires an inviter to name both the
// organization and the role up front. Neither shape leaves room for a
// self-service "just let me in" path.

export const requestMagicLinkInputSchema = z.strictObject({
  email: storedEmailSchema
});

export const createInviteInputSchema = z.strictObject({
  email: storedEmailSchema,
  organizationId: z.uuid(),
  role: z.enum(MEMBERSHIP_ROLES)
});

// ---- AF-20: immutable audit events ----

export const auditEventSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  auditEventId: z.uuid(),
  organizationId: z.uuid(),
  actorUserId: z.uuid(),
  action: z.enum(AUDIT_ACTIONS),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  requestId: requestIdSchema,
  occurredAt: z.iso.datetime()
}) satisfies z.ZodType<AuditEvent>;

// ---- AF-40: persist model/prompt/schema/rubric versions ----

export const evidenceExtractionRunSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  runId: z.uuid(),
  organizationId: z.uuid(),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  extractionSchemaVersion: z.string().min(1),
  extractionSchemaName: z.string().min(1),
  rubricVersion: z.string().min(1),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<EvidenceExtractionRun>;

// ---- AF-23: role creation ----

export const roleSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  roleId: z.uuid(),
  organizationId: z.uuid(),
  title: z.string().min(1),
  status: z.enum(ROLE_STATUSES),
  createdByUserId: z.uuid(),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<Role>;

/**
 * organizationId is required in the body, not inferred from the caller's
 * only membership: a caller can belong to more than one organization
 * (AF-15 puts no limit on memberships-per-user), so the request must say
 * which one it means. The route authorizes it server-side against the
 * caller's own memberships (authorizeResourceAccess) -- this schema only
 * shapes the input, it grants nothing.
 */
export const createRoleInputSchema = z.strictObject({
  organizationId: z.uuid(),
  title: z.string().trim().min(1).max(200)
});

export type CreateRoleInput = z.infer<typeof createRoleInputSchema>;

// ---- AF-25: rubric draft/edit ----

export const rubricCriterionSchema = z.strictObject({
  criterionId: z.string().min(1),
  description: z.string().trim().min(1).max(500),
  evidenceGuidance: z.string().trim().min(1).max(500)
}) satisfies z.ZodType<RubricCriterion>;

export const rubricSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  rubricId: z.uuid(),
  roleId: z.uuid(),
  version: z.number().int().min(1),
  status: z.enum(RUBRIC_STATUSES),
  criteria: z.array(rubricCriterionSchema),
  approvedByUserId: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}) satisfies z.ZodType<Rubric>;

/**
 * The 5-10 bound lives here, not only in AF-26's editor UI: an API caller
 * that bypasses the UI (a script, a future integration) must not be able
 * to save a 2-criterion or 40-criterion rubric just because the UI didn't
 * stop it.
 */
export const upsertRubricDraftInputSchema = z.strictObject({
  criteria: z.array(rubricCriterionSchema).min(MIN_RUBRIC_CRITERIA).max(MAX_RUBRIC_CRITERIA)
});

export type UpsertRubricDraftInput = z.infer<typeof upsertRubricDraftInputSchema>;

// ---- AF-28: secure direct file upload ----

export const fileIntakeSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  intakeId: z.uuid(),
  organizationId: z.uuid(),
  roleId: z.uuid(),
  storageKey: z.string().min(1),
  declaredFilename: z.string().min(1),
  declaredMimeType: z.string().min(1),
  status: z.enum(FILE_INTAKE_STATUSES),
  createdByUserId: z.uuid(),
  createdAt: z.iso.datetime(),
  sniffedMimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  sha256Hash: z.string().min(1).optional(),
  rejectionReason: z.string().min(1).optional()
}) satisfies z.ZodType<FileIntake>;

const ALLOWED_FILE_EXTENSION_PATTERN = new RegExp(`\\.(${ALLOWED_FILE_TYPES.join("|")})$`, "iu");

/**
 * Checks the declared filename's extension against the allowlist -- a
 * cheap, purely-cosmetic gate on what the client claims, not a security
 * boundary. AF-29 owns the real boundary: sniffing the uploaded bytes'
 * actual type once they land, which is the only check a malicious client
 * can't simply lie past by naming a file resume.pdf.
 */
export const requestFileUploadInputSchema = z.strictObject({
  declaredFilename: z.string().trim().min(1).max(255).regex(ALLOWED_FILE_EXTENSION_PATTERN, {
    message: `Filename must end in one of: ${ALLOWED_FILE_TYPES.join(", ")}`
  }),
  declaredMimeType: z.string().trim().min(1)
});

export type RequestFileUploadInput = z.infer<typeof requestFileUploadInputSchema>;

// ---- AF-30: PDF/DOCX canonical text parser ----

const canonicalTextPageSchema = z.strictObject({
  pageNumber: z.number().int().min(1),
  text: z.string(),
  characterCount: z.number().int().min(0)
}) satisfies z.ZodType<CanonicalTextPage>;

export const canonicalTextExtractionSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  extractionId: z.uuid(),
  intakeId: z.uuid(),
  pages: z.array(canonicalTextPageSchema),
  totalPages: z.number().int().min(1),
  quality: z.enum(["full", "partial", "empty"]),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<CanonicalTextExtraction>;

// ---- AF-31: CSV mapping and ten-row preview ----

export const csvColumnMappingEntrySchema = z.strictObject({
  field: z.enum(APPLICATION_IMPORT_FIELDS),
  csvColumnHeader: z.string().trim().min(1)
}) satisfies z.ZodType<CsvColumnMapping>;

/**
 * mapping is optional: an empty POST body is how the recruiter discovers
 * the file's headers before choosing one, not an error. Once a mapping is
 * supplied it's validated for real (packages/domain's
 * validateCsvColumnMapping) before any preview rows are computed.
 */
export const csvPreviewInputSchema = z.strictObject({
  mapping: z.array(csvColumnMappingEntrySchema).max(APPLICATION_IMPORT_FIELDS.length).optional()
});

export type CsvPreviewInput = z.infer<typeof csvPreviewInputSchema>;

// ---- AF-32: idempotent import finalization ----

export const applicationSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  applicationId: z.uuid(),
  organizationId: z.uuid(),
  roleId: z.uuid(),
  intakeId: z.uuid(),
  sourceRowNumber: z.number().int().min(1),
  candidateFullName: z.string().min(1),
  candidateEmail: z.string().min(1),
  externalReferenceId: z.string().min(1).optional(),
  appliedAt: z.string().min(1).optional(),
  createdAt: z.iso.datetime()
}) satisfies z.ZodType<Application>;

export const importRowSchema = z.strictObject({
  importRowId: z.uuid(),
  intakeId: z.uuid(),
  rowNumber: z.number().int().min(1),
  outcome: z.enum(IMPORT_ROW_OUTCOMES),
  applicationId: z.uuid().optional(),
  failureReason: z.string().min(1).optional()
}) satisfies z.ZodType<ImportRow>;

/**
 * mapping here is required (unlike AF-31's preview): finalizing without
 * a mapping makes no sense, there is no discovery mode for this action.
 * The Idempotency-Key header, not this body, is what makes a retry safe
 * -- see packages/db's finalizeCsvImport for the actual replay-vs-
 * conflict logic that key drives.
 */
export const finalizeCsvImportInputSchema = z.strictObject({
  mapping: z.array(csvColumnMappingEntrySchema).min(1).max(APPLICATION_IMPORT_FIELDS.length)
});

export type FinalizeCsvImportInput = z.infer<typeof finalizeCsvImportInputSchema>;

// ---- AF-45: tenant-scoped application review queue ----

export const applicationQueueEntrySchema = z.strictObject({
  application: applicationSchema,
  evidenceState: z.enum(APPLICATION_EVIDENCE_STATES),
  extractionRunCount: z.number().int().min(0),
  lastExtractionAt: z.iso.datetime().optional()
}) satisfies z.ZodType<ApplicationQueueEntry>;

/**
 * The counts are validated as a partition, not as three free integers:
 * a response where pendingExtractionCount + extractedCount does not
 * equal totalCount is describing a queue that cannot exist, and the
 * contract should reject it rather than let a UI render a total that
 * disagrees with its own breakdown.
 */
export const applicationReviewQueueSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    roleId: z.uuid(),
    totalCount: z.number().int().min(0),
    pendingExtractionCount: z.number().int().min(0),
    extractedCount: z.number().int().min(0),
    appliedStates: z.array(z.enum(APPLICATION_EVIDENCE_STATES)),
    shownCount: z.number().int().min(0),
    entries: z.array(applicationQueueEntrySchema)
  })
  .refine((queue) => queue.pendingExtractionCount + queue.extractedCount === queue.totalCount, {
    message: "pendingExtractionCount and extractedCount must sum to totalCount"
  })
  .refine((queue) => queue.entries.length === queue.shownCount, {
    message: "shownCount must match the number of entries returned"
  })
  .refine((queue) => queue.shownCount <= queue.totalCount, {
    message: "shownCount cannot exceed totalCount"
  })
  .refine((queue) => queue.appliedStates.length > 0 || queue.shownCount === queue.totalCount, {
    message: "an unfiltered queue must show every application it counted"
  })
  .refine(
    (queue) => queue.entries.every((entry) => queue.appliedStates.length === 0 || queue.appliedStates.includes(entry.evidenceState)),
    { message: "every entry returned must match one of the applied state filters" }
  )
  .refine((queue) => new Set(queue.appliedStates).size === queue.appliedStates.length, {
    message: "appliedStates must not repeat a state"
  });

// ---- AF-50: require correction reason and actor ----

/**
 * Mirrors 0018's CHECK exactly: a reason must contain at least one
 * character that is not whitespace.
 *
 * Deliberately not `.min(1)`, which accepts "   ", and deliberately not
 * `.trim().min(1)` either -- JavaScript's String.trim strips the full
 * Unicode whitespace set while Postgres's trim() strips spaces only, so
 * that pairing would make the two layers disagree in a direction the
 * database is looser. Asking both "does this contain a non-whitespace
 * character" makes them the same question.
 *
 * Verified against Postgres 17 rather than assumed: JS /\S/u and
 * `~ '[^[:space:]]'` agree on U+00A0 (both whitespace), U+3000 (both
 * whitespace) and U+200B (both non-whitespace). That last one is a
 * shared gap, not a divergence -- a reason of a single zero-width space
 * satisfies both. Left alone on purpose: closing it in TypeScript only
 * would break the mirror this schema exists to maintain, and there is a
 * test asserting the two layers still agree.
 */
export const correctionReasonSchema = z
  .string()
  .refine((value) => /\S/u.test(value), "must contain at least one non-whitespace character");

export const recordEvidenceCorrectionInputSchema = z.strictObject({
  outcome: evidenceOutcomeSchema,
  reason: correctionReasonSchema
});

// ---- AF-51: named human advance/hold/decline recording ----

export const candidateDecisionSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  decisionId: z.uuid(),
  organizationId: z.uuid(),
  applicationId: z.uuid(),
  decision: z.enum(CANDIDATE_DECISION_KINDS),
  rationale: correctionReasonSchema,
  decidedByUserId: z.uuid(),
  supersedesDecisionId: z.uuid().optional(),
  decidedAt: z.iso.datetime()
}) satisfies z.ZodType<CandidateDecision>;

/**
 * What a caller may send. Note what is absent: no decidedByUserId. The
 * actor is the session's own user, never a value in the request, so a
 * caller cannot record a decision in someone else's name -- and there is
 * nothing here a non-human caller could fill in to become one.
 */
export const recordCandidateDecisionInputSchema = z.strictObject({
  decision: z.enum(CANDIDATE_DECISION_KINDS),
  rationale: correctionReasonSchema
});
/**
 * AF-58. `failedRate` is nullable on purpose -- see summarizeFailedDocuments:
 * a role where nothing has resolved yet has no rate, and 0 would read as
 * "nothing failed". `.nullable()` forces every consumer to handle that.
 */
export const failedDocumentRateSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  organizationId: z.uuid(),
  roleId: z.uuid(),
  uploaded: z.number().int().min(0),
  failed: z.number().int().min(0),
  quarantined: z.number().int().min(0),
  rejected: z.number().int().min(0),
  extractionEmpty: z.number().int().min(0),
  extractionSucceeded: z.number().int().min(0),
  resolved: z.number().int().min(0),
  inFlight: z.number().int().min(0),
  failedRate: z.number().min(0).max(1).nullable()
}) satisfies z.ZodType<FailedDocumentRate>;

/**
 * AF-60. `value` is nullable at the contract boundary on purpose: a metric
 * whose sample cannot support it must be structurally incapable of
 * carrying a number, not merely accompanied by a warning that a renderer
 * can drop. `limitations` is required and may be empty -- an absent field
 * would be indistinguishable from "no limitations known", which is the
 * claim this ticket exists to prevent making by accident.
 */
export const metricLimitationSchema = z.strictObject({
  code: z.enum(METRIC_LIMITATION_CODES),
  detail: z.string().min(1)
}) satisfies z.ZodType<MetricLimitation>;

// The refinements below return a ZodEffects, which cannot carry the
// `satisfies z.ZodType<MetricSample>` binding the rest of this file uses
// to keep contracts and domain in step. Declaring the object shape first
// keeps that binding: if MetricSample gains a field, this stops compiling
// here rather than silently accepting a payload that omits it.
const metricSampleObjectSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  metric: z.string().min(1),
  value: z.number().finite().nullable(),
  sampleSize: z.number().int().min(0),
  population: z.number().int().min(0),
  minimumSampleSize: z.number().int().min(0),
  limitations: z.array(metricLimitationSchema)
}) satisfies z.ZodType<MetricSample>;

export const metricSampleSchema = metricSampleObjectSchema
  .refine((sample) => sample.sampleSize <= sample.population, {
    message: "sampleSize cannot exceed population",
    path: ["sampleSize"]
  })
  .refine(
    (sample) =>
      sample.value === null || (sample.sampleSize > 0 && sample.sampleSize >= sample.minimumSampleSize),
    {
      // The invariant the whole ticket rests on: a value may not cross the
      // boundary unless its own sample supports it. Without this the schema
      // would happily transport the exact thing summarizeMetric refuses to
      // produce.
      message: "a value must not be reported when sampleSize is 0 or below minimumSampleSize",
      path: ["value"]
    }
  );

/**
 * AF-55. The baseline half of the review-time comparison, validated at the
 * boundary because -- unlike every other number in this file -- it does not
 * originate inside the system. It is what an employer told us their old
 * process cost.
 *
 * `.positive()` rather than `.min(0)`: a zero baseline is not a small
 * baseline, it is a division by zero dressed as data, and it would yield an
 * infinite reduction that `metricSampleSchema` would then reject one layer
 * later with a message about finiteness that says nothing about the cause.
 *
 * `source` is required and has no default. A default would be chosen once,
 * here, and thereafter every baseline of unknown provenance would silently
 * acquire it -- which is exactly the fact this ticket needs to keep visible.
 */
export const reviewTimeBaselineSchema = z.strictObject({
  source: z.enum(REVIEW_TIME_BASELINE_SOURCES),
  medianActiveMs: z.number().positive().finite()
}) satisfies z.ZodType<ReviewTimeBaseline>;

/**
 * AF-56. The independent adjudication that the North Star safety metric
 * is measured against. Like the AF-55 baseline this arrives from outside
 * the system, and it is the more dangerous of the two: a contaminated
 * ground truth does not make the metric noisy, it makes the metric agree
 * with whatever it was supposed to be checking.
 *
 * `blindToWorkflowOutput` is required with no default, and is a boolean
 * rather than an optional flag, so an adjudication of unknown provenance
 * cannot be constructed at all. A default here would be applied once and
 * then inherited silently by every import that forgot to say.
 */
export const candidateAdjudicationSchema = z.strictObject({
  applicationId: z.uuid(),
  verdict: z.enum(["strong", "not_strong"]),
  blindToWorkflowOutput: z.boolean()
}) satisfies z.ZodType<CandidateAdjudication>;
