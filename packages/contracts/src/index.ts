import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  AUDIT_ACTIONS,
  CONTRACT_SCHEMA_VERSION,
  MAX_RUBRIC_CRITERIA,
  MEMBERSHIP_ROLES,
  MIN_RUBRIC_CRITERIA,
  ROLE_STATUSES,
  RUBRIC_STATUSES
} from "@signal-audit/domain";
import type { ContractSchemaVersion } from "@signal-audit/domain";
import type {
  AuditEvent,
  CitationInvalidEvidence,
  ContradictedEvidence,
  DomainPort,
  EvidenceExtractionRun,
  EvidenceOutcome,
  ExtractionErrorEvidence,
  FailedEvidence,
  InvalidSourceEvidence,
  Membership,
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

/** Placeholder boundary shape; a later ticket beyond AF-13 owns wiring this
 * into a real adapter boundary. The versioned runtime contracts themselves
 * (evidenceOutcomeSchema and friends, below) are AF-13's actual deliverable
 * and already live in this file. */
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

/** Recursive JSON-value schema: restricts a field to values that can
 * actually survive `JSON.stringify`/`Response.json`, without requiring
 * any particular shape. Used both for `rejectedCitation` below (which
 * must preserve a structurally malformed proposal, just not one
 * containing something like a bigint that would throw at the transport
 * boundary) and for `BuildApiErrorInput.details` further down.
 *
 * A cycle check runs before the recursive Zod parse itself: a self-referential
 * object is still a `Record` at the type level, but it can never survive JSON
 * and would otherwise overflow the stack while walking the graph. */
function hasCircularJsonReference(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return true;
  }
  ancestors.add(value);
  try {
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    return children.some((entry) => hasCircularJsonReference(entry, ancestors));
  } catch {
    return true;
  } finally {
    ancestors.delete(value);
  }
}

const recursiveJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    // `.finite()` is explicit on purpose: TypeScript's `number` admits
    // Infinity and NaN, neither of which survives JSON -- both serialize
    // to `null`, silently changing the value at the transport boundary.
    // `-0` is rejected for the same reason and is easy to miss, because
    // it IS finite: `JSON.stringify(-0)` emits `0`, so the value a caller
    // handed in is not the value that comes back out the other side.
    z.number().finite().refine((value) => !Object.is(value, -0), {
      message: "must not be negative zero, which JSON serializes as 0"
    }),
    z.boolean(),
    z.null(),
    z.array(recursiveJsonValueSchema),
    z.record(z.string(), recursiveJsonValueSchema)
  ])
);

const jsonValueSchema: z.ZodType<JsonValue> = z.unknown().transform((value, context) => {
  try {
    if (!hasCircularJsonReference(value)) {
      const parsed = recursiveJsonValueSchema.safeParse(value);
      if (parsed.success) {
        return parsed.data;
      }
    }
  } catch {
    // Report traversal/parsing exceptions as validation failures below.
  }
  context.addIssue({ code: "custom", message: "must be a cycle-free JSON value" });
  return z.NEVER;
});

const supportedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("supported"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<SupportedEvidence>;

const partiallySupportedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("partially_supported"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<PartiallySupportedEvidence>;

const contradictedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("contradicted"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema,
  conflictingCitation: sourceCitationSchema
}) satisfies z.ZodType<ContradictedEvidence>;

const unclearEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("unclear"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  citation: sourceCitationSchema
}) satisfies z.ZodType<UnclearEvidence>;

const notFoundEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("not_found"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1)
}) satisfies z.ZodType<NotFoundEvidence>;

const processingEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("processing"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1)
}) satisfies z.ZodType<ProcessingEvidence>;

/** attempt <= maxAttempts is a real invariant, not just two independent
 * minimums: {attempt: 4, maxAttempts: 3} describes an already-exhausted
 * retry budget, which is what the `failed` kind exists for. */
const retryingEvidenceSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("retrying"),
    organizationId: z.uuid(),
    candidateId: z.string().min(1),
    criterionId: z.string().min(1),
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1)
  })
  .refine((value) => value.attempt <= value.maxAttempts, {
    message: "attempt cannot exceed maxAttempts",
    path: ["attempt"]
  }) satisfies z.ZodType<RetryingEvidence>;

const extractionErrorEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("extraction_error"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
}) satisfies z.ZodType<ExtractionErrorEvidence>;

const citationInvalidEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("citation_invalid"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  reason: z.string().min(1),
  rejectedCitation: jsonValueSchema
}) satisfies z.ZodType<CitationInvalidEvidence>;

const invalidSourceEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("invalid_source"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  reason: z.string().min(1)
}) satisfies z.ZodType<InvalidSourceEvidence>;

const unsupportedFileEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("unsupported_file"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  reason: z.string().min(1)
}) satisfies z.ZodType<UnsupportedFileEvidence>;

const quarantinedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("quarantined"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  quarantineClass: z.enum(["malicious", "unsupported", "corrupt", "persistent_failure"]),
  reason: z.string().min(1),
  operatorActionRequired: z.literal(true)
}) satisfies z.ZodType<QuarantinedEvidence>;

const failedEvidenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("failed"),
  organizationId: z.uuid(),
  candidateId: z.string().min(1),
  criterionId: z.string().min(1),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  retryable: z.literal(false)
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

/**
 * Attach the request ID header without disturbing any other headers.
 * `RequestId` is a plain alias, not a branded type, so the compiler
 * cannot stop `withRequestId(headers, "bad")`. The guard below is the
 * same boundary check `buildApiError` makes for the same reason: a
 * caller that propagates an untrusted inbound `X-Request-Id` straight
 * through fails loudly here instead of silently emitting a response
 * header that fails `requestIdSchema`.
 */
export function withRequestId(headers: HeadersInit | undefined, requestId: RequestId): Headers {
  if (!requestIdSchema.safeParse(requestId).success) {
    throw new Error(`withRequestId requires a well-formed RequestId, got: ${requestId}`);
  }
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

/** Recursive JSON-value type: what `details` is restricted to. A caller
 * handing in a bigint, a class instance, or a function would previously
 * type-check against `Record<string, unknown>` and then blow up at the
 * actual `Response.json`/`JSON.stringify` call site instead of here.
 *
 * TypeScript cannot express "finite number", so `number` here still
 * admits Infinity and NaN. `jsonValueSchema` rejects both at runtime,
 * and `buildApiError` parses its constructed body through
 * `apiErrorBodySchema` so a non-finite `details` value cannot escape as
 * a body that serializes to a different value than it type-checked as. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The one shape every error response on the API surface takes. */
export interface ApiErrorBody {
  readonly schemaVersion: ContractSchemaVersion;
  readonly requestId: RequestId;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: Record<string, JsonValue> | undefined;
  };
}

export const apiErrorBodySchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  requestId: requestIdSchema,
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1),
    details: z.record(z.string(), jsonValueSchema).optional()
  })
}) satisfies z.ZodType<ApiErrorBody>;

export interface BuildApiErrorInput {
  readonly requestId: RequestId;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Record<string, JsonValue>;
}

export interface ApiErrorResponse {
  readonly status: number;
  readonly body: ApiErrorBody;
}

/**
 * Build a status + body pair; callers hand `body` to their own JSON
 * response. The checks here guard this function's own contract, not user
 * input: every real call site generates `requestId` via
 * `generateRequestId()` and passes a literal `message`, so none of them
 * should ever fire in legitimate use -- they exist so a caller that
 * propagates an untrusted `X-Request-Id` straight through, constructs a
 * blank message, or passes a `details` value that cannot survive JSON
 * fails loudly here instead of silently producing a body that fails its
 * own `apiErrorBodySchema`.
 *
 * The final `apiErrorBodySchema.safeParse` is what makes that promise
 * total rather than partial. Checking `requestId` and `message`
 * individually still left `details` unchecked, and `JsonValue`'s
 * `number` member admits Infinity/NaN, so a fully type-checked
 * `details: { count: Infinity }` produced a body that failed the very
 * schema this function advertises and serialized as `{"count":null}` --
 * a changed value, not a rejected one.
 */
export function buildApiError(input: BuildApiErrorInput): ApiErrorResponse {
  if (!requestIdSchema.safeParse(input.requestId).success) {
    throw new Error(`buildApiError requires a well-formed RequestId, got: ${input.requestId}`);
  }
  if (input.message.length === 0) {
    throw new Error("buildApiError requires a non-empty message");
  }
  const body: ApiErrorBody = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: input.requestId,
    error: {
      code: input.code,
      message: input.message,
      ...(input.details === undefined ? {} : { details: input.details })
    }
  };
  const parsed = apiErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `buildApiError produced a body that fails apiErrorBodySchema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return { status: API_ERROR_STATUS[input.code], body: parsed.data };
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
  // Only an absent header is "missing" -- Headers.get() returns "" for a
  // header the caller explicitly sent empty, which is a distinct mistake
  // from never sending one at all. Let it fall through to the schema,
  // which rejects "" for real (the regex requires at least one char) and
  // reports it as "invalid" with an actual reason instead of collapsing
  // it into the same bucket as not sending the header.
  if (headerValue === null) {
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
  // Trimmed for the same reason description and evidenceGuidance are, and
  // it matters more here: criterionId is the key the extraction pipeline
  // matches an extracted item against, so " python " and "python" naming
  // the same criterion would be two different keys, and a whitespace-only
  // id would be a criterion nothing can ever cite. Trimming also makes the
  // uniqueness rule below mean what it says -- without it, "a" and "a "
  // are technically distinct and would both be accepted.
  criterionId: z.string().trim().min(1),
  description: z.string().trim().min(1).max(500),
  evidenceGuidance: z.string().trim().min(1).max(500)
}) satisfies z.ZodType<RubricCriterion>;

/**
 * Duplicate criterion IDs are rejected here because the layer that
 * consumes a rubric already rejects them: mapRubricToEvidence throws
 * `requires unique rubric criterion IDs; "<id>" appears more than once`
 * rather than silently emitting two outcomes for one criterion, since
 * that would contradict its one-outcome-per-criterion invariant.
 *
 * Without this check the two layers disagreed about what a valid rubric
 * is, and the API was the more permissive one: a recruiter could save a
 * rubric with the same criterion five times, get a 200, and only discover
 * it was malformed when the first extraction run against that role blew
 * up. A save that succeeds and a run that cannot is the worst split,
 * because the failure surfaces far from the edit that caused it.
 *
 * Reported against the duplicate element's own index rather than the
 * whole array, so an editor can highlight the offending row, and it names
 * the earlier position so the author can see which two collide.
 */
function addDuplicateCriterionIdIssues(
  criteria: readonly RubricCriterion[],
  context: z.RefinementCtx
): void {
  const firstIndexById = new Map<string, number>();
  criteria.forEach((criterion, index) => {
    const firstIndex = firstIndexById.get(criterion.criterionId);
    if (firstIndex === undefined) {
      firstIndexById.set(criterion.criterionId, index);
      return;
    }
    context.addIssue({
      code: "custom",
      path: ["criteria", index, "criterionId"],
      message: `criterionId "${criterion.criterionId}" is already used by criterion ${firstIndex + 1}; a rubric cannot score the same criterion twice`
    });
  });
}

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
})
  // The stored/returned rubric carries the same rule as the input that
  // produced it. A rubric that only became valid on the way in, and is
  // invalid once read back, would leave the API describing something the
  // pipeline still refuses to run.
  .superRefine((value, context) => {
    addDuplicateCriterionIdIssues(value.criteria, context);
  }) satisfies z.ZodType<Rubric>;

/**
 * The 5-10 bound lives here, not only in AF-26's editor UI: an API caller
 * that bypasses the UI (a script, a future integration) must not be able
 * to save a 2-criterion or 40-criterion rubric just because the UI didn't
 * stop it.
 */
export const upsertRubricDraftInputSchema = z
  .strictObject({
    criteria: z.array(rubricCriterionSchema).min(MIN_RUBRIC_CRITERIA).max(MAX_RUBRIC_CRITERIA)
  })
  .superRefine((value, context) => {
    addDuplicateCriterionIdIssues(value.criteria, context);
  });

export type UpsertRubricDraftInput = z.infer<typeof upsertRubricDraftInputSchema>;
