/** Stable, framework-neutral marker used only to prove dependency direction. */
export const DOMAIN_LAYER_NAME = "domain" as const;

/**
 * Minimal domain-owned abstraction for AF-10 wiring checks.
 * Real product ports and domain contracts belong to later tickets.
 */
export interface DomainPort {
  readonly layer: typeof DOMAIN_LAYER_NAME;
}

// ---- AF-13: versioned domain contracts and state invariants ----
//
// Every record below is pinned to CONTRACT_SCHEMA_VERSION so a future
// incompatible change ships as a new version rather than a silent reshape.
// EvidenceOutcome is a discriminated union, not a status string: each kind
// only has the fields that are valid for it, so (for example) `not_found`
// is structurally incapable of also carrying a citation, and `failed` is
// structurally distinct from `quarantined`. See docs/PRODUCT_BOUNDARY.md
// for the canonical, non-decisional state vocabulary this maps to.

export const CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

export interface VersionedRecord {
  readonly schemaVersion: ContractSchemaVersion;
}

/** Where in the employer-authorized source material a quote came from. */
export interface SourceCitation {
  readonly document: string;
  readonly pageOrSection: string;
  readonly offset: number;
  readonly quote: string;
}

/** Kinds that found candidate material bearing on the requirement and must cite it. */
export interface SupportedEvidence extends VersionedRecord {
  readonly kind: "supported";
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

export interface PartiallySupportedEvidence extends VersionedRecord {
  readonly kind: "partially_supported";
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

export interface ContradictedEvidence extends VersionedRecord {
  readonly kind: "contradicted";
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

/** Something was found but the match is ambiguous; still must cite what was found. */
export interface UnclearEvidence extends VersionedRecord {
  readonly kind: "unclear";
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

/** Nothing relevant was found; there is no citation to attach. */
export interface NotFoundEvidence extends VersionedRecord {
  readonly kind: "not_found";
  readonly criterionId: string;
}

/** Pipeline is still working; no evidence value exists yet. */
export interface ProcessingEvidence extends VersionedRecord {
  readonly kind: "processing";
  readonly criterionId: string;
}

/** Pipeline is retrying after a retryable failure. */
export interface RetryingEvidence extends VersionedRecord {
  readonly kind: "retrying";
  readonly criterionId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** Extraction itself broke before any evidence value could be produced. */
export interface ExtractionErrorEvidence extends VersionedRecord {
  readonly kind: "extraction_error";
  readonly criterionId: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** The model proposed a citation that failed exact-source validation (AF-38). */
export interface CitationInvalidEvidence extends VersionedRecord {
  readonly kind: "citation_invalid";
  readonly criterionId: string;
  readonly reason: string;
  readonly rejectedCitation: SourceCitation;
}

/** The source material itself could not be used (corrupt, empty, unreadable). */
export interface InvalidSourceEvidence extends VersionedRecord {
  readonly kind: "invalid_source";
  readonly criterionId: string;
  readonly reason: string;
}

/** The source file's format is not one ingestion currently supports. */
export interface UnsupportedFileEvidence extends VersionedRecord {
  readonly kind: "unsupported_file";
  readonly criterionId: string;
  readonly reason: string;
}

export type QuarantineClass = "malicious" | "unsupported" | "corrupt" | "persistent_failure";

/** Requires an operator to act; never an implicit path to a hiring outcome. */
export interface QuarantinedEvidence extends VersionedRecord {
  readonly kind: "quarantined";
  readonly criterionId: string;
  readonly quarantineClass: QuarantineClass;
  readonly reason: string;
  readonly operatorActionRequired: boolean;
}

/** Pipeline failed and retries are exhausted or not applicable. */
export interface FailedEvidence extends VersionedRecord {
  readonly kind: "failed";
  readonly criterionId: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type EvidenceOutcome =
  | SupportedEvidence
  | PartiallySupportedEvidence
  | ContradictedEvidence
  | UnclearEvidence
  | NotFoundEvidence
  | ProcessingEvidence
  | RetryingEvidence
  | ExtractionErrorEvidence
  | CitationInvalidEvidence
  | InvalidSourceEvidence
  | UnsupportedFileEvidence
  | QuarantinedEvidence
  | FailedEvidence;

export type EvidenceOutcomeKind = EvidenceOutcome["kind"];

export const EVIDENCE_OUTCOME_KINDS: readonly EvidenceOutcomeKind[] = [
  "supported",
  "partially_supported",
  "contradicted",
  "unclear",
  "not_found",
  "processing",
  "retrying",
  "extraction_error",
  "citation_invalid",
  "invalid_source",
  "unsupported_file",
  "quarantined",
  "failed"
] as const;

/**
 * Exhaustiveness guard for callers switching on EvidenceOutcome. A switch
 * that omits a kind fails to compile at the call site instead of silently
 * collapsing an unhandled state into a handled one.
 */
export function assertUnreachableEvidenceOutcome(outcome: never): never {
  throw new Error(`Unhandled EvidenceOutcome kind: ${JSON.stringify(outcome)}`);
}

// ---- AF-15: organization, user, and membership schema ----
//
// Organization is the tenant/policy root. Users hold roles via
// memberships; MembershipRole is a closed set, not a free-text string,
// so an invalid role can't be typed into existence, only rejected by
// both the TypeScript type and the database CHECK constraint. See
// docs/PRODUCT_BOUNDARY.md POL-011: every future query over these
// records must stay scoped by organizationId, never cross it.

export type MembershipRole = "owner" | "admin" | "recruiter" | "auditor";

export const MEMBERSHIP_ROLES: readonly MembershipRole[] = [
  "owner",
  "admin",
  "recruiter",
  "auditor"
] as const;

export interface Organization extends VersionedRecord {
  readonly organizationId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface User extends VersionedRecord {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

/** One membership per (organizationId, userId); a role change updates it in place. */
export interface Membership extends VersionedRecord {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly createdAt: string;
}

// ---- AF-16: invite-only magic-link authentication ----
//
// These are internal persistence-layer shapes shared between
// packages/db (the atomic single-use redemption SQL) and
// packages/security (the pure verification decision), not versioned
// wire contracts -- they use real Date values, not ISO strings, and are
// never passed through a Zod parse. There is no public self-service
// signup: a token is either a plain login link for an existing user
// (no invite) or an invite granting a specific role in a specific
// organization on redemption.

/** Present only when the token is an invite, not a plain login link. */
export interface MagicLinkInvite {
  readonly organizationId: string;
  readonly role: MembershipRole;
}

export interface MagicLinkTokenRecord {
  readonly email: string;
  readonly invite?: MagicLinkInvite;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

/**
 * The one honest answer to "was this atomic redemption attempt the call
 * that consumed the token." `record` is undefined only when the token
 * hash has never existed. This distinction can only be known by whoever
 * ran the atomic UPDATE (packages/db); it is not recoverable from
 * `record` alone, since a token this call just redeemed and a token
 * redeemed earlier both end up with `consumedAt` set.
 */
export interface MagicLinkRedemptionAttempt {
  readonly justRedeemed: boolean;
  readonly record: MagicLinkTokenRecord | undefined;
}

/**
 * Explicit, non-collapsing outcomes for verifying a magic-link token.
 * "expired" and "already_consumed" are structurally distinct failure
 * reasons, not the same rejected-token status string.
 */
export type MagicLinkVerification =
  | { readonly outcome: "valid"; readonly email: string; readonly invite?: MagicLinkInvite }
  | { readonly outcome: "expired" }
  | { readonly outcome: "already_consumed" }
  | { readonly outcome: "not_found" };

/** Domain-owned port; packages/security provides a dev-only console adapter. */
export interface MagicLinkEmailSender {
  sendMagicLink(input: { readonly email: string; readonly link: string }): Promise<void>;
}

// ---- AF-17: owner/admin/recruiter/auditor roles ----
//
// The policy itself: which capabilities each MembershipRole has. This is
// pure data plus a pure lookup, not enforcement -- AF-19 (server-side
// resource authorization) is where a request's membership gets checked
// against this policy and turned into an ApiErrorBody. Auditor is
// deliberately read-only: it can view_audit_reports but cannot review
// candidates, record decisions, or approve rubrics, matching its role as
// oversight, not a decision-maker (POL-001: humans, named and
// attributable, make employment decisions -- auditor is not that human).

export type Capability =
  | "approve_rubric"
  | "review_candidates"
  | "record_decision"
  | "view_audit_reports"
  | "access_admin_settings"
  | "manage_roles";

export const CAPABILITIES: readonly Capability[] = [
  "approve_rubric",
  "review_candidates",
  "record_decision",
  "view_audit_reports",
  "access_admin_settings",
  "manage_roles"
] as const;

/**
 * Owner and admin currently have identical capabilities: nothing here
 * distinguishes them yet, since no org-lifecycle capability (transfer
 * ownership, delete organization, remove an admin) exists yet. Owner is
 * kept as its own role rather than merged into admin because those
 * future capabilities will belong to owner only.
 */
export const ROLE_CAPABILITIES: Readonly<Record<MembershipRole, readonly Capability[]>> = {
  owner: ["approve_rubric", "review_candidates", "record_decision", "view_audit_reports", "access_admin_settings", "manage_roles"],
  admin: ["approve_rubric", "review_candidates", "record_decision", "view_audit_reports", "access_admin_settings", "manage_roles"],
  recruiter: ["review_candidates", "record_decision", "manage_roles"],
  auditor: ["view_audit_reports"]
};

export function roleHasCapability(role: MembershipRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

// ---- AF-20: immutable audit events ----
//
// Every one of these four actions is required by docs/PRODUCT_BOUNDARY.md
// POL-001 to be attributable to a named human, so actorUserId is never
// optional and never a "system" placeholder. Append-only is enforced at
// the database layer (a trigger, not a privilege grant -- see
// packages/db/migrations/0005_immutable_audit_events.sql for why) and
// reinforced here by only ever exposing an append function, never an
// update or delete, from packages/db.

export type AuditAction = "rubric_approved" | "evidence_corrected" | "decision_recorded" | "admin_action";

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "rubric_approved",
  "evidence_corrected",
  "decision_recorded",
  "admin_action"
] as const;

export interface AuditEvent extends VersionedRecord {
  readonly auditEventId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly occurredAt: string;
}

// ---- AF-34: provider-neutral AI adapter ----
//
// This port is deliberately generic (an arbitrary JSON Schema in, an
// arbitrary parsed JSON value out), not shaped around evidence
// extraction specifically -- AF-35 owns the actual extraction schema
// and prompt on top of this. Nothing here names OpenAI, so a future
// provider swap only touches packages/ai's adapter implementation, never
// this interface or any caller of it.

export interface AiStructuredCallInput {
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly schemaName: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

/** Token counts the provider reported for one call, not an estimate. */
export interface AiCallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Recorded on every call so AF-40 can persist it and AF-41 can meter
 * it. `usage` is a fact about the response (the provider reports it),
 * unlike promptVersion/schemaVersion/schemaName which the caller
 * supplies as input -- that's why it lives here rather than on
 * AiStructuredCallInput.
 */
export interface AiCallMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly schemaName: string;
  readonly usage: AiCallUsage;
}

export interface AiStructuredCallResult {
  readonly output: unknown;
  readonly metadata: AiCallMetadata;
}

export interface AiAdapter {
  runStructuredCall(input: AiStructuredCallInput): Promise<AiStructuredCallResult>;
}

// ---- AF-40: persist model/prompt/schema/rubric versions ----
//
// A generic entityType/entityId pair (matching AuditEvent, AF-20)
// rather than a foreign key into an "applications" table that doesn't
// exist yet. rubricVersion is not part of AiCallMetadata (AF-34):
// AiAdapter is a generic structured-output port with no concept of a
// rubric, so the caller supplies it here at the point of persistence,
// the same way it already supplies promptVersion/schemaVersion to the
// adapter itself. The AI extraction schema's own version/name are
// named extractionSchemaVersion/extractionSchemaName, not schemaVersion/
// schemaName, so they cannot be confused with this record's own
// VersionedRecord.schemaVersion (always CONTRACT_SCHEMA_VERSION) --
// two genuinely different versions that happen to share a word.

export interface EvidenceExtractionRun extends VersionedRecord {
  readonly runId: string;
  readonly organizationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly extractionSchemaVersion: string;
  readonly extractionSchemaName: string;
  readonly rubricVersion: string;
  readonly createdAt: string;
}

// ---- AF-41: inference cost/budget tracking ----
//
// A pure decision over numbers the caller already knows (accumulated
// usage so far this period, and the configured cap) -- no I/O, no
// period-length opinion. packages/db owns accumulating tokensUsedThisPeriod
// (an UPSERT-increment ledger keyed by organization+model+period), and
// whatever period length (daily, monthly) an operator configures is
// just what value gets passed in as the period boundary; this function
// doesn't know or care.

export interface InferenceBudgetConfig {
  readonly maxTokensPerPeriod: number;
  /** e.g. 0.8 warns once 80% of the cap is used, before it is fully spent. */
  readonly alertThresholdRatio: number;
}

export interface InferenceUsageSnapshot {
  readonly tokensUsedThisPeriod: number;
}

/**
 * Explicit, non-collapsing outcomes: "warning" (approaching the cap)
 * and "capped" (at or over it) are structurally distinct, not two
 * values of one generic status, because a caller must never mistake
 * "you should slow down" for "you are blocked."
 */
export type InferenceBudgetStatus =
  | { readonly outcome: "ok" }
  | { readonly outcome: "warning"; readonly tokensUsedThisPeriod: number; readonly maxTokensPerPeriod: number }
  | { readonly outcome: "capped"; readonly tokensUsedThisPeriod: number; readonly maxTokensPerPeriod: number };

export function checkInferenceBudget(
  usage: InferenceUsageSnapshot,
  config: InferenceBudgetConfig
): InferenceBudgetStatus {
  const { tokensUsedThisPeriod } = usage;
  const { maxTokensPerPeriod, alertThresholdRatio } = config;

  if (tokensUsedThisPeriod >= maxTokensPerPeriod) {
    return { outcome: "capped", tokensUsedThisPeriod, maxTokensPerPeriod };
  }
  if (tokensUsedThisPeriod >= maxTokensPerPeriod * alertThresholdRatio) {
    return { outcome: "warning", tokensUsedThisPeriod, maxTokensPerPeriod };
  }
  return { outcome: "ok" };
}

// ---- AF-42: inference kill switch ----
//
// A pure gate over state the caller already fetched -- no I/O here.
// When engaged, callers must treat the block as retryable (see
// packages/ai's killSwitchRetryOutcome), not a permanent failure:
// "without losing queued work" means the switch pauses the pipeline,
// it does not discard what was queued.

export interface InferenceKillSwitchStatus {
  readonly engaged: boolean;
  readonly reason?: string;
}

export type InferenceCallGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function checkInferenceKillSwitch(status: InferenceKillSwitchStatus): InferenceCallGate {
  if (!status.engaged) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: status.reason ?? "Inference is currently halted by an operator kill switch."
  };
}

// ---- AF-23: role creation ----
//
// "Role" here is a hiring role (a job), not to be confused with
// MembershipRole (owner/admin/recruiter/auditor) above -- two different
// concepts that happen to share the English word. A role starts in
// draft (no rubric yet, nothing can be imported against it) and only
// ever reaches active once EPIC 3's later tickets (rubric approval,
// AF-27) let it. closed is terminal: a closed role's rubric can no
// longer accept new imports, matching the immutability invariant
// AF-27 will enforce on published rubric versions.

export type RoleStatus = "draft" | "active" | "closed";

export const ROLE_STATUSES: readonly RoleStatus[] = ["draft", "active", "closed"] as const;

export interface Role extends VersionedRecord {
  readonly roleId: string;
  readonly organizationId: string;
  readonly title: string;
  readonly status: RoleStatus;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

// ---- AF-25: rubric draft/edit ----
//
// A rubric's own `version` (a plain per-role integer, 1/2/3...) is a
// different thing from CONTRACT_SCHEMA_VERSION on VersionedRecord: this
// one is a product concept the recruiter sees ("rubric v2"), the other is
// this codebase's own payload-shape version. Draft is the only status
// AF-25 produces or edits; AF-27 owns the transition to published and the
// immutability that follows it, so this type already has the fields that
// transition needs (approvedByUserId/approvedAt) even though AF-25 never
// sets them.

export interface RubricCriterion {
  readonly criterionId: string;
  readonly description: string;
  readonly evidenceGuidance: string;
}

export type RubricStatus = "draft" | "published";

export const RUBRIC_STATUSES: readonly RubricStatus[] = ["draft", "published"] as const;

export const MIN_RUBRIC_CRITERIA = 5;
export const MAX_RUBRIC_CRITERIA = 10;

export interface Rubric extends VersionedRecord {
  readonly rubricId: string;
  readonly roleId: string;
  readonly version: number;
  readonly status: RubricStatus;
  readonly criteria: readonly RubricCriterion[];
  readonly approvedByUserId?: string | undefined;
  readonly approvedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---- AF-26: protected-characteristic proxy flagging ----
//
// A heuristic phrase scanner, same spirit as AF-44's INJECTION_PATTERNS:
// this is a regression suite of known problematic phrasings, not a claim
// of legal completeness or a substitute for an employer's own legal
// review. It flags for a human to look at (AF-26 asks the UI to "flag,"
// not to block saving) -- a criterion that trips this can still be
// saved; the point is making the recruiter look at it once, not gating
// the editor on an incomplete pattern list. Placed in packages/domain
// (zero deps) rather than packages/ai so a browser bundle can run this
// live, as-you-type, without pulling in an AI provider SDK for a feature
// that has nothing to do with model calls.

export type ProtectedCharacteristicCategory =
  | "age"
  | "national_origin_or_language"
  | "gender"
  | "disability"
  | "family_status";

interface ProtectedCharacteristicPattern {
  readonly category: ProtectedCharacteristicCategory;
  readonly pattern: RegExp;
}

const PROTECTED_CHARACTERISTIC_PATTERNS: readonly ProtectedCharacteristicPattern[] = [
  { category: "age", pattern: /\b(digital native|young and energetic|recent grad(uate)?s? only|years young)\b/iu },
  { category: "age", pattern: /\bunder \d{2}\b/iu },
  { category: "national_origin_or_language", pattern: /\bnative (english|[a-z]+) speaker\b/iu },
  { category: "national_origin_or_language", pattern: /\bno accents?\b/iu },
  { category: "gender", pattern: /\b(he|she) must\b/iu },
  { category: "gender", pattern: /\bmanpower\b/iu },
  { category: "disability", pattern: /\bable[- ]bodied\b/iu },
  { category: "disability", pattern: /\bno (physical|medical) limitations\b/iu },
  { category: "family_status", pattern: /\b(no children|childless|unmarried) (preferred|required)\b/iu },
  { category: "family_status", pattern: /\bavailable (nights|weekends) with no family (obligations|commitments)\b/iu }
];

export interface ProtectedCharacteristicFlag {
  readonly category: ProtectedCharacteristicCategory;
  readonly matchedPhrase: string;
}

/** Flags every match, not just the first -- the same criterion text can
 * read as more than one kind of proxy at once. */
export function scanCriterionForProtectedCharacteristicProxy(
  text: string
): readonly ProtectedCharacteristicFlag[] {
  return PROTECTED_CHARACTERISTIC_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ category, pattern }) => ({ category, matchedPhrase: pattern.source })
  );
}

// ---- AF-28: secure direct file upload ----
//
// FileIntake tracks one upload attempt from "a URL was minted" through
// (in later tickets) validated/quarantined/rejected. AF-28 only ever
// produces pending and uploaded; the rest of this closed set exists now
// so AF-29 doesn't need a second migration touching the status CHECK.

export const ALLOWED_FILE_TYPES = ["pdf", "docx", "csv"] as const;
export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

/** "imported" is added by AF-32, not AF-28: a CSV intake reaches it once
 * (never again -- finalization is one-shot, same as every other
 * transition here), pdf/docx intakes never reach it at all. */
export type FileIntakeStatus = "pending" | "uploaded" | "validated" | "quarantined" | "rejected" | "imported";

export const FILE_INTAKE_STATUSES: readonly FileIntakeStatus[] = [
  "pending",
  "uploaded",
  "validated",
  "quarantined",
  "rejected",
  "imported"
] as const;

export interface FileIntake extends VersionedRecord {
  readonly intakeId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly storageKey: string;
  readonly declaredFilename: string;
  readonly declaredMimeType: string;
  readonly status: FileIntakeStatus;
  readonly createdByUserId: string;
  readonly createdAt: string;
  /** Set once AF-29's validation has actually run; absent before that. */
  readonly sniffedMimeType?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly sha256Hash?: string | undefined;
  readonly rejectionReason?: string | undefined;
}

// ---- AF-29: file allowlist, MIME validation, hash and quarantine ----
//
// Pure decision logic only -- packages/ingestion owns fetching the
// object, sniffing its real bytes, hashing, and reading a ZIP's central
// directory (all of which need real I/O and a third-party sniffer);
// this function just decides, given those already-gathered facts,
// whether the file is safe to hand to AF-30's parser.

export const MAX_FILE_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB

/** Real MIME types file-type actually reports for the three allowed
 * extensions -- deliberately not the client-declared Content-Type,
 * which is exactly what a disguised file lies about. */
export const ALLOWED_SNIFFED_MIME_TYPES: Readonly<Record<AllowedFileType, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv"
};

/**
 * A ZIP whose central directory declares an uncompressed size wildly
 * larger than the file actually uploaded is the classic zip-bomb shape
 * (one tiny compressed entry, an enormous declared uncompressed size).
 * Bounded two ways, either one is enough to flag: an absolute cap
 * (protects even a large legitimate upload) and a compression-ratio cap
 * (protects a small upload from claiming to unpack to something absurd).
 */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MiB
export const MAX_DOCX_COMPRESSION_RATIO = 200;

export interface FileValidationInput {
  readonly declaredFilename: string;
  /** undefined when file-type recognized no known signature at all. */
  readonly sniffedMimeType: string | undefined;
  readonly sizeBytes: number;
  /** undefined for a non-ZIP-based file (a CSV, or a PDF); present (from
   * packages/ingestion's central-directory scan) whenever the sniffed
   * type is ZIP-based, i.e. docx. */
  readonly zipUncompressedBytes?: number | undefined;
}

export type FileValidationOutcome =
  | { readonly outcome: "validated" }
  | { readonly outcome: "quarantined"; readonly reason: string };

export function evaluateFileValidation(input: FileValidationInput): FileValidationOutcome {
  if (input.sizeBytes > MAX_FILE_UPLOAD_BYTES) {
    return {
      outcome: "quarantined",
      reason: `File is ${input.sizeBytes} bytes, over the ${MAX_FILE_UPLOAD_BYTES}-byte limit.`
    };
  }
  if (input.sniffedMimeType === undefined) {
    return { outcome: "quarantined", reason: "Could not identify the file's real type from its contents." };
  }
  const allowedType = (Object.entries(ALLOWED_SNIFFED_MIME_TYPES) as [AllowedFileType, string][]).find(
    ([, mimeType]) => mimeType === input.sniffedMimeType
  );
  if (allowedType === undefined) {
    return {
      outcome: "quarantined",
      reason: `Sniffed type ${input.sniffedMimeType} is not on the allowlist (pdf, docx, csv).`
    };
  }
  const [fileType] = allowedType;
  if (!input.declaredFilename.toLowerCase().endsWith(`.${fileType}`)) {
    return {
      outcome: "quarantined",
      reason: `Filename claims a different type than its real content (sniffed as ${fileType}).`
    };
  }
  if (input.zipUncompressedBytes !== undefined) {
    if (input.zipUncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
      return {
        outcome: "quarantined",
        reason: `Archive declares ${input.zipUncompressedBytes} uncompressed bytes, over the ${MAX_DOCX_UNCOMPRESSED_BYTES}-byte cap.`
      };
    }
    const ratio = input.zipUncompressedBytes / Math.max(input.sizeBytes, 1);
    if (ratio > MAX_DOCX_COMPRESSION_RATIO) {
      return {
        outcome: "quarantined",
        reason: `Archive's compression ratio (${ratio.toFixed(1)}x) exceeds the ${MAX_DOCX_COMPRESSION_RATIO}x archive-bomb threshold.`
      };
    }
  }
  return { outcome: "validated" };
}

// ---- AF-30: PDF/DOCX canonical text parser ----
//
// "Page-aware" means genuinely per-page for PDF (pages are a real,
// stored concept there); a DOCX has no reliable page-break data without
// a full layout engine, so it's always exactly one page here -- a real
// limitation, documented rather than faked with an invented page count.
//
// "Visible quality/coverage state, not a silent best-effort extraction"
// is why this is never just a string: a scanned/image-only PDF page
// parses to an empty string with no error (there is nothing wrong, from
// the parser's point of view, about a page with no text layer) -- if
// that silently looked identical to a real empty page, a recruiter
// would have no way to tell "this evidence extraction found nothing
// because the résumé really says nothing here" apart from "because this
// page was never actually readable text to begin with."

export type CanonicalTextQuality = "full" | "partial" | "empty";

const MIN_MEANINGFUL_PAGE_CHARACTERS = 20;

export interface CanonicalTextPage {
  readonly pageNumber: number;
  readonly text: string;
  readonly characterCount: number;
}

export interface CanonicalTextExtraction extends VersionedRecord {
  readonly extractionId: string;
  readonly intakeId: string;
  readonly pages: readonly CanonicalTextPage[];
  readonly totalPages: number;
  readonly quality: CanonicalTextQuality;
  readonly createdAt: string;
}

/**
 * empty: no page has meaningful text (a scanned PDF with no OCR layer,
 * or a genuinely blank document). partial: some pages do, some don't
 * (a résumé with one image-only page mixed into otherwise real text).
 * full: every page has meaningful text.
 */
export function evaluateCanonicalTextQuality(
  pages: readonly { readonly characterCount: number }[]
): CanonicalTextQuality {
  if (pages.length === 0) {
    return "empty";
  }
  const meaningfulPages = pages.filter((page) => page.characterCount >= MIN_MEANINGFUL_PAGE_CHARACTERS).length;
  if (meaningfulPages === 0) {
    return "empty";
  }
  return meaningfulPages < pages.length ? "partial" : "full";
}

// ---- AF-31: CSV mapping and ten-row preview ----
//
// No "applications" table exists yet (AF-32 is what first creates one),
// so this is a closed, deliberately small set of fields a recruiter can
// map a CSV column onto -- just enough for AF-32 to have something real
// to finalize against. Everything here is pure: packages/ingestion owns
// actually parsing the CSV's bytes into headers/rows (a real I/O and
// third-party-library concern); this only ever operates on already-
// parsed strings.

export const APPLICATION_IMPORT_FIELDS = [
  "candidateFullName",
  "candidateEmail",
  "externalReferenceId",
  "appliedAt"
] as const;
export type ApplicationImportField = (typeof APPLICATION_IMPORT_FIELDS)[number];

/** externalReferenceId and appliedAt are optional: not every recruiter's
 * export has a tracking ID or an applied-date column. */
export const REQUIRED_APPLICATION_IMPORT_FIELDS: readonly ApplicationImportField[] = [
  "candidateFullName",
  "candidateEmail"
] as const;

export const MAX_CSV_PREVIEW_ROWS = 10;

export interface CsvColumnMapping {
  readonly field: ApplicationImportField;
  readonly csvColumnHeader: string;
}

export type CsvMappingValidationOutcome =
  | { readonly outcome: "valid" }
  | { readonly outcome: "invalid"; readonly reasons: readonly string[] };

/**
 * Checked against the file's actual header row, not just the mapping's
 * own internal shape: a header the recruiter picked has to still exist
 * in the CSV, every required field has to be covered, and nothing can
 * be mapped twice in either direction (two fields fed from the same
 * column, or the same field fed from two columns) since either would
 * silently produce wrong data rather than fail loudly.
 */
export function validateCsvColumnMapping(
  headers: readonly string[],
  mapping: readonly CsvColumnMapping[]
): CsvMappingValidationOutcome {
  const reasons: string[] = [];

  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length > 0) {
    reasons.push(`CSV header row has duplicate column names, so column-based mapping is ambiguous: ${duplicateHeaders.join(", ")}`);
  }

  if (mapping.length === 0) {
    reasons.push("At least one column must be mapped.");
  }

  const seenFields = new Set<ApplicationImportField>();
  const seenHeaders = new Set<string>();
  for (const entry of mapping) {
    if (seenFields.has(entry.field)) {
      reasons.push(`Field "${entry.field}" is mapped from more than one column.`);
    }
    seenFields.add(entry.field);

    if (seenHeaders.has(entry.csvColumnHeader)) {
      reasons.push(`Column "${entry.csvColumnHeader}" is mapped to more than one field.`);
    }
    seenHeaders.add(entry.csvColumnHeader);

    if (!headers.includes(entry.csvColumnHeader)) {
      reasons.push(`Column "${entry.csvColumnHeader}" does not exist in this CSV's header row.`);
    }
  }

  for (const requiredField of REQUIRED_APPLICATION_IMPORT_FIELDS) {
    if (!seenFields.has(requiredField)) {
      reasons.push(`Required field "${requiredField}" is not mapped to any column.`);
    }
  }

  return reasons.length === 0 ? { outcome: "valid" } : { outcome: "invalid", reasons };
}

/** Blank/whitespace-only cells map to undefined, not "", so a recruiter
 * previewing the import sees an honest gap rather than an empty string
 * that looks like real (but empty) data. */
export function mapCsvRowToApplication(
  row: Readonly<Record<string, string>>,
  mapping: readonly CsvColumnMapping[]
): Readonly<Record<ApplicationImportField, string | undefined>> {
  const result: Record<ApplicationImportField, string | undefined> = {
    candidateFullName: undefined,
    candidateEmail: undefined,
    externalReferenceId: undefined,
    appliedAt: undefined
  };
  for (const entry of mapping) {
    const rawValue = row[entry.csvColumnHeader];
    const trimmed = rawValue?.trim();
    result[entry.field] = trimmed === undefined || trimmed === "" ? undefined : trimmed;
  }
  return result;
}

export interface CsvPreviewRow {
  readonly rowNumber: number;
  readonly values: Readonly<Record<ApplicationImportField, string | undefined>>;
}

export interface CsvPreviewResult {
  readonly totalDataRows: number;
  readonly previewRows: readonly CsvPreviewRow[];
}

/** Only ever previews, never persists -- AF-32 is where an accepted
 * mapping is actually applied to every row and turned into durable
 * application records. */
export function buildCsvPreview(
  rows: readonly Readonly<Record<string, string>>[],
  mapping: readonly CsvColumnMapping[]
): CsvPreviewResult {
  const previewRows = rows.slice(0, MAX_CSV_PREVIEW_ROWS).map((row, index) => ({
    rowNumber: index + 1,
    values: mapCsvRowToApplication(row, mapping)
  }));
  return { totalDataRows: rows.length, previewRows };
}

// ---- AF-32: idempotent import finalization ----
//
// The applications table this whole intake/validate/parse/preview
// pipeline (AF-28-31) has been building toward. Every CSV data row gets
// exactly one outcome, decided purely from the same mapped values AF-31
// already computes: a row missing every required field is a blank
// spacer row (skipped, not an error); a row missing only some of them
// is a real but broken row the recruiter needs to see (failed); a row
// with everything required present becomes a durable Application
// (processed). "Nothing disappears silently" means every row gets one
// of these three, never a fourth, silent option.

export type ImportRowOutcome = "processed" | "failed" | "skipped";

export const IMPORT_ROW_OUTCOMES: readonly ImportRowOutcome[] = ["processed", "failed", "skipped"] as const;

export interface Application extends VersionedRecord {
  readonly applicationId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly intakeId: string;
  readonly sourceRowNumber: number;
  readonly candidateFullName: string;
  readonly candidateEmail: string;
  readonly externalReferenceId?: string | undefined;
  readonly appliedAt?: string | undefined;
  readonly createdAt: string;
}

export interface ImportRow {
  readonly importRowId: string;
  readonly intakeId: string;
  readonly rowNumber: number;
  readonly outcome: ImportRowOutcome;
  readonly applicationId?: string | undefined;
  readonly failureReason?: string | undefined;
}

export type ImportRowClassification =
  | { readonly outcome: "processed" }
  | { readonly outcome: "failed"; readonly reason: string }
  | { readonly outcome: "skipped" };

/** Pure: given the same mapped values AF-31's preview already computes
 * for a row, decides its fate without ever touching the database. */
export function classifyCsvImportRow(
  values: Readonly<Record<ApplicationImportField, string | undefined>>
): ImportRowClassification {
  const missingRequired = REQUIRED_APPLICATION_IMPORT_FIELDS.filter((field) => values[field] === undefined);
  if (missingRequired.length === REQUIRED_APPLICATION_IMPORT_FIELDS.length) {
    return { outcome: "skipped" };
  }
  if (missingRequired.length > 0) {
    return { outcome: "failed", reason: `Missing required field(s): ${missingRequired.join(", ")}` };
  }
  return { outcome: "processed" };
}

export interface ImportFinalizationSummary {
  readonly totalRows: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}

export function summarizeImportRows(
  rows: readonly { readonly outcome: ImportRowOutcome }[]
): ImportFinalizationSummary {
  return {
    totalRows: rows.length,
    processedCount: rows.filter((row) => row.outcome === "processed").length,
    failedCount: rows.filter((row) => row.outcome === "failed").length,
    skippedCount: rows.filter((row) => row.outcome === "skipped").length
  };
}

/**
 * Order-independent, so a client resubmitting the same logical mapping
 * with its entries in a different order still counts as the same
 * mapping for idempotency-key comparison -- what matters is what it
 * means, not the array order the client happened to send.
 */
export function canonicalizeCsvColumnMapping(mapping: readonly CsvColumnMapping[]): string {
  const sorted = [...mapping].sort((a, b) => a.field.localeCompare(b.field));
  return JSON.stringify(sorted.map((entry) => ({ field: entry.field, csvColumnHeader: entry.csvColumnHeader })));
}

// ---- AF-33: processing/failure status UI ----
//
// "waiting" only ever means "not finalized yet": AF-32's finalize is one
// atomic transaction, not a queue that drains rows one at a time, so
// there is no real in-progress state to report mid-import. Before
// finalize every row is waiting; the instant it commits, none are --
// they have all become processed, failed, or skipped in the same step.

export interface ImportStatusSummary extends ImportFinalizationSummary {
  readonly status: "waiting" | "finalized";
  readonly waitingCount: number;
}

export function buildImportStatusSummary(
  totalRows: number,
  rows: readonly { readonly outcome: ImportRowOutcome }[]
): ImportStatusSummary {
  if (rows.length === 0) {
    return {
      status: "waiting",
      totalRows,
      processedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      waitingCount: totalRows
    };
  }
  return { status: "finalized", ...summarizeImportRows(rows), waitingCount: 0 };
}

const CSV_FIELD_ESCAPE_PATTERN = /[",\n]/u;

function escapeCsvField(value: string): string {
  return CSV_FIELD_ESCAPE_PATTERN.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

/**
 * The recruiter's "downloadable error list": only failed rows, since
 * skipped rows were never meant to become applications (a blank spacer
 * row needs no attention) and processed rows succeeded.
 */
export function buildImportErrorsCsv(rows: readonly ImportRow[]): string {
  const header = "row_number,failure_reason";
  const lines = rows
    .filter((row): row is ImportRow & { readonly failureReason: string } => row.outcome === "failed")
    .map((row) => `${row.rowNumber},${escapeCsvField(row.failureReason)}`);
  return [header, ...lines].join("\n") + "\n";
}

// ---- AF-45: tenant-scoped application review queue ----
//
// The recruiter's main working view for one role: every imported
// application and where it currently sits in evidence processing.
//
// The honest scope of "evidence-processing state" here, because it is
// narrower than the ticket's wording suggests and that is deliberate.
// AF-13 defines a rich EvidenceOutcome union (supported, contradicted,
// unclear, citation_invalid, quarantined, ...), but nothing persists
// those: it is a contract type the pipeline returns, with no table
// behind it. The only durable evidence that extraction ran against an
// entity is AF-40's evidence_extraction_runs. So this reports the two
// states actually derivable from stored data and says so, rather than
// adding a per-criterion status column the database cannot back. When
// evidence outcomes get a table, this union gains members; it is not
// retrofitted with guesses now. That is the same call AF-24 made for
// rubric approval and import readiness on the roles list.

/**
 * The entity_type an evidence_extraction_runs row uses when the entity
 * is an application. Nothing writes those rows for applications yet, so
 * this constant exists to stop the reader and the eventual writer from
 * each inventing their own string -- a mismatch there would show every
 * application as pending_extraction forever, with no error anywhere.
 */
export const APPLICATION_ENTITY_TYPE = "application";

export type ApplicationEvidenceState = "pending_extraction" | "extracted";

export const APPLICATION_EVIDENCE_STATES: readonly ApplicationEvidenceState[] = [
  "pending_extraction",
  "extracted"
] as const;

/** Just the fields the queue needs from an extraction run; the full row
 * carries model/prompt/schema/rubric versions this view never shows. */
export interface EvidenceExtractionRunRef {
  readonly entityType: string;
  readonly entityId: string;
  readonly createdAt: string;
}

export interface ApplicationQueueEntry {
  readonly application: Application;
  readonly evidenceState: ApplicationEvidenceState;
  readonly extractionRunCount: number;
  /** Most recent run for this application, when at least one exists. */
  readonly lastExtractionAt?: string | undefined;
}

export interface ApplicationReviewQueue extends VersionedRecord {
  readonly roleId: string;
  readonly totalCount: number;
  readonly pendingExtractionCount: number;
  readonly extractedCount: number;
  readonly entries: readonly ApplicationQueueEntry[];
}

/**
 * Pure: pairs a role's applications with whatever extraction runs exist
 * for them. Never touches the database, so the ordering and counting
 * rules are testable without one.
 *
 * Ordering is AF-46's guarantee: see compareApplicationsBySourceOrder.
 */
// ---- AF-46: preserve original applicant ordering ----
//
// "Default queue order matches original application order, not a hidden
// score." There is no score to sort by, and this is the ticket that
// makes that a guarantee rather than an accident of what the database
// happened to return.
//
// The order the employer gave us is reconstructed from three columns,
// in this priority:
//
//  1. createdAt -- which is a per-INTAKE key, not a per-row one.
//     AF-32's finalize inserts every application for one CSV inside a
//     single transaction, and `DEFAULT CURRENT_TIMESTAMP` is transaction
//     *start* time, so every row from one import shares one identical
//     value. It orders imports against each other; it says nothing
//     about rows within an import.
//  2. intakeId -- the tiebreak that actually matters. Because createdAt
//     is shared, two imports whose transactions began at the same
//     instant collide on it, and without this the next comparison would
//     be sourceRowNumber: intake A's row 1, intake B's row 1, A's row 2,
//     B's row 2. That interleaves two employers' import batches into one
//     another and is precisely the "order is not the original order"
//     failure this ticket exists to prevent. Comparing intakeId first
//     keeps each import contiguous; which of the two tied imports comes
//     first is arbitrary but stable, and never interleaved.
//  3. sourceRowNumber -- the row's position in the file the employer
//     uploaded. Within one import this is the original order, exactly.
//
// applicationId is a final tiebreak only, and should be unreachable:
// two applications sharing an intake and a row number would mean
// finalize ran twice for one row, which AF-32's idempotency prevents.
// It is here so the comparator is a total order under every input,
// including malformed ones, rather than leaving ties to the engine's
// sort stability.
//
// Deliberately NOT part of the ordering: appliedAt. It is optional (the
// employer may not supply it), self-reported, and sorting by it would
// silently reorder a recruiter's queue away from the file they uploaded
// -- a different order, not the original one. Nothing here ranks,
// scores, or prioritises; POL-003 forbids a score field existing at all,
// and there is no column in this comparison that could act as one.
export function compareApplicationsBySourceOrder(a: Application, b: Application): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    a.intakeId.localeCompare(b.intakeId) ||
    a.sourceRowNumber - b.sourceRowNumber ||
    a.applicationId.localeCompare(b.applicationId)
  );
}

export function buildApplicationReviewQueue(
  roleId: string,
  applications: readonly Application[],
  runs: readonly EvidenceExtractionRunRef[]
): ApplicationReviewQueue {
  const runsByApplicationId = new Map<string, string[]>();
  for (const run of runs) {
    if (run.entityType !== APPLICATION_ENTITY_TYPE) {
      continue;
    }
    const existing = runsByApplicationId.get(run.entityId);
    if (existing === undefined) {
      runsByApplicationId.set(run.entityId, [run.createdAt]);
    } else {
      existing.push(run.createdAt);
    }
  }

  const entries = [...applications]
    .sort(compareApplicationsBySourceOrder)
    .map((application): ApplicationQueueEntry => {
      const runTimes = runsByApplicationId.get(application.applicationId) ?? [];
      if (runTimes.length === 0) {
        return { application, evidenceState: "pending_extraction", extractionRunCount: 0 };
      }
      // Max by string comparison is safe here: these are ISO-8601 UTC
      // timestamps produced by toISOString(), so lexical order is
      // chronological order for every value this can receive.
      const lastExtractionAt = runTimes.reduce((latest, current) => (current > latest ? current : latest));
      return {
        application,
        evidenceState: "extracted",
        extractionRunCount: runTimes.length,
        lastExtractionAt
      };
    });

  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    roleId,
    totalCount: entries.length,
    pendingExtractionCount: entries.filter((entry) => entry.evidenceState === "pending_extraction").length,
    extractedCount: entries.filter((entry) => entry.evidenceState === "extracted").length,
    entries
  };
}
