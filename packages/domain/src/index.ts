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
  /**
   * Counts always describe the whole role, never the filtered view.
   * AF-47: a filter that also shrinks the totals cannot tell a recruiter
   * how much it is hiding, and "3 applications" on a filtered screen
   * reads as "this role has 3 applications". These stay whole so the UI
   * can honestly say "showing 3 of 12".
   */
  readonly totalCount: number;
  readonly pendingExtractionCount: number;
  readonly extractedCount: number;
  /** Which states the caller asked for; empty means "no filter applied". */
  readonly appliedStates: readonly ApplicationEvidenceState[];
  /** entries.length, stated explicitly so a truncated response is detectable. */
  readonly shownCount: number;
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
  runs: readonly EvidenceExtractionRunRef[],
  states: readonly ApplicationEvidenceState[] = []
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

  // Filtering happens after the queue is built and after it is ordered,
  // never as part of either. AF-46's order is a property of the whole
  // queue, so a filtered view has to be a subsequence of it -- selecting
  // rows must not be able to reorder the rows it keeps.
  const requested = new Set(states);
  const shown = requested.size === 0 ? entries : entries.filter((entry) => requested.has(entry.evidenceState));

  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    roleId,
    totalCount: entries.length,
    pendingExtractionCount: entries.filter((entry) => entry.evidenceState === "pending_extraction").length,
    extractedCount: entries.filter((entry) => entry.evidenceState === "extracted").length,
    appliedStates: [...requested],
    shownCount: shown.length,
    entries: shown
  };
}

// ---- AF-47: explicit state filters ----
//
// "Filter by unreviewed/incomplete/contradiction/error state -- explicit
// filters, never a hidden ranking."
//
// Of the four states the ticket names, exactly one is answerable from
// data that exists. `unreviewed` is `pending_extraction`: no extraction
// run has been recorded against the application (AF-40's
// evidence_extraction_runs). `incomplete`, `contradiction` and `error`
// are all per-criterion EvidenceOutcome kinds, and nothing persists
// those -- EvidenceOutcome is a contract type the pipeline returns, with
// no table behind it. Offering them as filters that quietly match
// nothing would be worse than not offering them: a recruiter filtering
// for contradictions and seeing an empty list would reasonably conclude
// there are none.
//
// So the closed set below is the set that can be answered honestly, and
// the UI shows the other three as unavailable with the reason, rather
// than hiding them or faking them. When outcomes get a table this set
// grows; nothing else about the mechanism has to change.
//
// The "never a hidden ranking" half is structural, not a promise:
// filtering is applied to an already-ordered queue as a subsequence, so
// selecting rows cannot reorder the rows it keeps, and the whole-role
// counts are computed before filtering so the view can always say how
// much it is hiding.

export type ApplicationStateFilterParse =
  | { readonly ok: true; readonly states: readonly ApplicationEvidenceState[] }
  | { readonly ok: false; readonly unknownValues: readonly string[] };

function isApplicationEvidenceState(value: string): value is ApplicationEvidenceState {
  return (APPLICATION_EVIDENCE_STATES as readonly string[]).includes(value);
}

/**
 * Parses the caller's requested filter, rejecting anything outside the
 * closed set rather than dropping it.
 *
 * Silently ignoring an unrecognised value is how a filter becomes a lie:
 * `?state=contradiction` would return every application, and the screen
 * would present the full queue as if it were the contradictions. A
 * misspelled or not-yet-supported filter has to fail loudly.
 *
 * Accepts repeated params and comma-separated values, trims surrounding
 * whitespace, and treats an entirely absent filter as "no filter" -- but
 * NOT an explicitly empty one, which is a caller mistake and reported as
 * such.
 */
export function parseApplicationStateFilter(
  rawValues: readonly string[]
): ApplicationStateFilterParse {
  const requested = rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const unknownValues = [...new Set(requested.filter((value) => !isApplicationEvidenceState(value)))];
  if (unknownValues.length > 0) {
    return { ok: false, unknownValues };
  }
  // An explicitly present but empty filter (?state=) is a caller
  // mistake, not "show everything" -- same distinction AF-14 draws
  // between a missing and an empty Idempotency-Key header.
  if (requested.length === 0 && rawValues.length > 0) {
    return { ok: false, unknownValues: [""] };
  }
  return { ok: true, states: [...new Set(requested.filter(isApplicationEvidenceState))] };
}

// ---- AF-48: evidence card with source context ----
//
// "Criterion, state, exact quote, and source shown beside the original
// application document for immediate verification."
//
// buildEvidenceCard is exhaustive over all thirteen EvidenceOutcome
// kinds via assertUnreachableEvidenceOutcome, so a new kind fails to
// compile here instead of silently rendering as a blank card.
//
// The honest part. Four kinds carry a quote a recruiter can check
// (supported, partially_supported, contradicted, unclear) and one
// carries a quote that was *rejected* (citation_invalid, whose whole
// point is that the proposed citation did not survive AF-38's exact
// match). The other eight cannot carry one -- not_found found nothing,
// processing has not finished, quarantined never reached the model. For
// those the card reports verifiable: false with the reason the kind
// itself gives, so the UI can say why there is nothing to check rather
// than rendering an empty quote box that looks like a bug.

export interface EvidenceCardCitation {
  /** What this quote is, so two quotes on a contradicted card are distinguishable. */
  readonly role: "supporting" | "conflicting" | "rejected";
  readonly citation: SourceCitation;
}

/**
 * AF-49: what a recruiter needs to see to trust a corrected card --
 * that it was corrected, by whom, why, and what it said before.
 * Absent on an uncorrected card rather than present-and-empty, so
 * "corrected" is a state you can check for rather than infer from a
 * blank string.
 */
export interface EvidenceCorrectionProvenance {
  readonly correctedByUserId: string;
  readonly reason: string;
  readonly correctedAt: string;
  /** The state this correction replaced -- the "before" half. */
  readonly previousKind: EvidenceOutcomeKind;
  readonly previousCitations: readonly EvidenceCardCitation[];
}

export interface EvidenceCard {
  readonly criterionId: string;
  readonly kind: EvidenceOutcomeKind;
  readonly citations: readonly EvidenceCardCitation[];
  readonly correction?: EvidenceCorrectionProvenance | undefined;
  /**
   * Whether a recruiter can check this card against source material.
   * False is a legitimate, explained state, not a missing value.
   */
  readonly verifiable: boolean;
  /** Why this outcome is what it is, when the kind carries a reason. */
  readonly explanation?: string | undefined;
  readonly recordedAt: string;
}

export function buildEvidenceCard(outcome: EvidenceOutcome, recordedAt: string): EvidenceCard {
  const base = { criterionId: outcome.criterionId, kind: outcome.kind, recordedAt } as const;
  switch (outcome.kind) {
    case "supported":
    case "partially_supported":
    case "unclear":
      return {
        ...base,
        citations: [{ role: "supporting", citation: outcome.citation }],
        verifiable: true
      };
    case "contradicted":
      // Both sides of the conflict, labelled, because a contradiction a
      // recruiter cannot see both halves of is not reviewable.
      //
      // The `in` check and cast are load-bearing and temporary.
      // ContradictedEvidence on this branch carries one citation;
      // AF-13's review added `conflictingCitation` and that fix is on
      // develop, not yet propagated up this stack. Reading it
      // defensively means the second quote appears the moment the fixed
      // union arrives at merge, instead of a contradicted card silently
      // showing one side. Delete the guard once the union has both.
      return {
        ...base,
        citations: [
          { role: "supporting", citation: outcome.citation },
          ...("conflictingCitation" in outcome && outcome.conflictingCitation !== undefined
            ? [{ role: "conflicting" as const, citation: outcome.conflictingCitation as SourceCitation }]
            : [])
        ],
        verifiable: true
      };
    case "citation_invalid":
      // Shown, but never as evidence: this is the quote the model
      // proposed and validation rejected. Displaying it is what lets a
      // recruiter see that the system caught a hallucination rather than
      // silently dropping the criterion.
      return {
        ...base,
        citations: [{ role: "rejected", citation: outcome.rejectedCitation as SourceCitation }],
        verifiable: false,
        explanation: outcome.reason
      };
    case "not_found":
      return { ...base, citations: [], verifiable: false, explanation: "No relevant material was found." };
    case "processing":
      return { ...base, citations: [], verifiable: false, explanation: "Extraction has not finished." };
    case "retrying":
      return {
        ...base,
        citations: [],
        verifiable: false,
        explanation: `Retrying after a recoverable failure (attempt ${outcome.attempt} of ${outcome.maxAttempts}).`
      };
    case "extraction_error":
      return { ...base, citations: [], verifiable: false, explanation: outcome.message };
    case "invalid_source":
    case "unsupported_file":
      return { ...base, citations: [], verifiable: false, explanation: outcome.reason };
    case "quarantined":
      return {
        ...base,
        citations: [],
        verifiable: false,
        explanation: `Quarantined (${outcome.quarantineClass}): ${outcome.reason}`
      };
    case "failed":
      return { ...base, citations: [], verifiable: false, explanation: outcome.message };
    default:
      return assertUnreachableEvidenceOutcome(outcome);
  }
}

export interface EvidenceCardSet {
  readonly applicationId: string;
  readonly cards: readonly EvidenceCard[];
  readonly verifiableCount: number;
  readonly unverifiableCount: number;
}

/**
 * Cards in rubric order, not in whatever order the database returned.
 * A criterion the rubric names but nothing has been recorded for is
 * reported as `processing` rather than omitted -- a review screen that
 * silently drops a criterion tells a recruiter the rubric was smaller
 * than it is, which is the one failure mode this whole card is meant to
 * prevent.
 */
export function buildEvidenceCardSet(
  applicationId: string,
  rubricCriterionIds: readonly string[],
  recorded: readonly { readonly outcome: EvidenceOutcome; readonly recordedAt: string }[]
): EvidenceCardSet {
  const byCriterion = new Map<string, { readonly outcome: EvidenceOutcome; readonly recordedAt: string }>();
  for (const entry of recorded) {
    const existing = byCriterion.get(entry.outcome.criterionId);
    // Newest wins, which is how AF-49's append-only corrections will
    // supersede an original without this needing to change.
    if (existing === undefined || entry.recordedAt > existing.recordedAt) {
      byCriterion.set(entry.outcome.criterionId, entry);
    }
  }

  const cards = rubricCriterionIds.map((criterionId): EvidenceCard => {
    const entry = byCriterion.get(criterionId);
    if (entry === undefined) {
      return {
        criterionId,
        kind: "processing",
        citations: [],
        verifiable: false,
        explanation: "No evidence has been recorded for this criterion yet.",
        recordedAt: ""
      };
    }
    return buildEvidenceCard(entry.outcome, entry.recordedAt);
  });

  return {
    applicationId,
    cards,
    verifiableCount: cards.filter((card) => card.verifiable).length,
    unverifiableCount: cards.filter((card) => !card.verifiable).length
  };
}

// ---- AF-49: append-only evidence corrections ----
//
// "Recruiter corrections never overwrite the original AI output --
// before/after state is preserved for every correction."
//
// The append-only half is the database's (0016 rejects UPDATE, DELETE
// and TRUNCATE; 0017 makes every correction name what it replaced).
// What belongs here is the reading: turning a chain of revisions into a
// current card that carries its own before/after, so a recruiter looking
// at a corrected criterion can see it was corrected without going to
// look for a history somewhere else. A correction the reviewer has to go
// hunting for is one they will not check.

export interface EvidenceRevision {
  readonly evidenceOutcomeId: string;
  readonly outcome: EvidenceOutcome;
  readonly recordedAt: string;
  readonly correctedByUserId?: string | undefined;
  readonly correctionReason?: string | undefined;
  readonly supersedesEvidenceOutcomeId?: string | undefined;
}

/**
 * The head of each criterion's revision chain, with the correction that
 * produced it (if any) resolved against the revision it replaced.
 *
 * The head is found by following supersedes links, not by taking the
 * newest timestamp: 0017 makes the chain a stored fact precisely so this
 * does not have to be an inference. The head is the one revision no
 * other revision supersedes. Timestamps break the tie only among
 * criterion chains that are genuinely independent.
 */
export function resolveCurrentEvidenceRevisions(
  revisions: readonly EvidenceRevision[]
): readonly EvidenceRevision[] {
  const superseded = new Set(
    revisions
      .map((revision) => revision.supersedesEvidenceOutcomeId)
      .filter((id): id is string => id !== undefined)
  );
  const heads = new Map<string, EvidenceRevision>();
  for (const revision of revisions) {
    if (superseded.has(revision.evidenceOutcomeId)) {
      continue;
    }
    const criterionId = revision.outcome.criterionId;
    const existing = heads.get(criterionId);
    // A criterion should have exactly one unsuperseded revision. If a
    // history somehow forked despite 0017's unique index, take the newest
    // rather than an arbitrary one, so the view is at least deterministic.
    if (existing === undefined || revision.recordedAt > existing.recordedAt) {
      heads.set(criterionId, revision);
    }
  }
  return [...heads.values()];
}

export function buildCorrectedEvidenceCard(
  revisions: readonly EvidenceRevision[],
  head: EvidenceRevision
): EvidenceCard {
  const card = buildEvidenceCard(head.outcome, head.recordedAt);
  // AF-50: all three of who, why and what-it-replaced, or this is not
  // reported as a correction at all. 0017 and 0018 make a partial one
  // unrepresentable in the database, so reaching here means an
  // incomplete read -- and a card that says "corrected" while unable to
  // say by whom or why is exactly the unanswerable audit answer those
  // constraints exist to prevent. Previously `reason` defaulted to ""
  // here, which produced that card.
  if (
    head.correctedByUserId === undefined ||
    head.supersedesEvidenceOutcomeId === undefined ||
    head.correctionReason === undefined ||
    !/\S/u.test(head.correctionReason)
  ) {
    return card;
  }
  const previous = revisions.find(
    (revision) => revision.evidenceOutcomeId === head.supersedesEvidenceOutcomeId
  );
  if (previous === undefined) {
    // The predecessor is missing from what we were given. Reporting the
    // correction without its "before" would be worse than not claiming
    // one: it would show a card as corrected while quietly failing the
    // requirement the correction exists to satisfy. 0016 makes deletion
    // impossible, so this means an incomplete read, not lost data.
    return card;
  }
  const previousCard = buildEvidenceCard(previous.outcome, previous.recordedAt);
  return {
    ...card,
    correction: {
      correctedByUserId: head.correctedByUserId,
      reason: head.correctionReason,
      correctedAt: head.recordedAt,
      previousKind: previousCard.kind,
      previousCitations: previousCard.citations
    }
  };
}

/**
 * AF-49's card set: the same rubric-ordered shape AF-48 produces, built
 * from the full revision history so every corrected card carries its own
 * before/after.
 *
 * Kept as a separate entry point rather than changing
 * buildEvidenceCardSet's signature: that function takes "the current
 * outcome per criterion" and is the right shape for a caller that has
 * only that. This one takes the history, which is strictly more, and
 * only a caller that has read the history can use it.
 */
export function buildCorrectedEvidenceCardSet(
  applicationId: string,
  rubricCriterionIds: readonly string[],
  revisions: readonly EvidenceRevision[]
): EvidenceCardSet {
  const heads = new Map(
    resolveCurrentEvidenceRevisions(revisions).map((head) => [head.outcome.criterionId, head])
  );
  const cards = rubricCriterionIds.map((criterionId): EvidenceCard => {
    const head = heads.get(criterionId);
    if (head === undefined) {
      return {
        criterionId,
        kind: "processing",
        citations: [],
        verifiable: false,
        explanation: "No evidence has been recorded for this criterion yet.",
        recordedAt: ""
      };
    }
    return buildCorrectedEvidenceCard(revisions, head);
  });
  return {
    applicationId,
    cards,
    verifiableCount: cards.filter((card) => card.verifiable).length,
    unverifiableCount: cards.filter((card) => !card.verifiable).length
  };
}

// ---- AF-51: named human advance/hold/decline recording ----
//
// "The only place a candidate's workflow status changes. Always a named
// human action with a rationale field; the model has no path to this
// endpoint."
//
// Status is DERIVED, never stored. There is no status column on
// applications and this module offers no way to set one -- a candidate's
// workflow status is a function of the decision log and nothing else, so
// there is no second copy to drift and no other writer to audit. That is
// what makes "the only place" a property of the schema rather than a
// convention.

export type CandidateDecisionKind = "advance" | "hold" | "decline";

export const CANDIDATE_DECISION_KINDS: readonly CandidateDecisionKind[] = [
  "advance",
  "hold",
  "decline"
] as const;

export interface CandidateDecision extends VersionedRecord {
  readonly decisionId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly decision: CandidateDecisionKind;
  /** Why. Never optional: an unexplained decision is not reviewable. */
  readonly rationale: string;
  /** Who. Never optional and never a service account -- see 0019. */
  readonly decidedByUserId: string;
  readonly supersedesDecisionId?: string | undefined;
  readonly decidedAt: string;
}

/**
 * `undecided` is a real state, not a missing value: a candidate nobody
 * has ruled on yet is different from one held, and collapsing the two
 * would let an untouched application read as a deliberate outcome.
 */
export type CandidateWorkflowStatus =
  | { readonly status: "undecided" }
  | {
      readonly status: CandidateDecisionKind;
      readonly decidedByUserId: string;
      readonly rationale: string;
      readonly decidedAt: string;
      readonly decisionId: string;
      /** How many times this candidate's status has been revised. */
      readonly revisionCount: number;
    };

/**
 * The current decision is the one nothing supersedes, found by following
 * the supersedes links rather than by taking the newest timestamp. 0019
 * stores that link precisely so this is a lookup and not an inference:
 * two decisions recorded in the same microsecond, or any clock skew,
 * must not be able to invert which one stands.
 */
export function deriveCandidateWorkflowStatus(
  decisions: readonly CandidateDecision[]
): CandidateWorkflowStatus {
  if (decisions.length === 0) {
    return { status: "undecided" };
  }
  const superseded = new Set(
    decisions.map((decision) => decision.supersedesDecisionId).filter((id): id is string => id !== undefined)
  );
  const heads = decisions.filter((decision) => !superseded.has(decision.decisionId));
  // 0019's partial unique index makes more than one head impossible.
  // If one somehow appears, take the newest so the view is at least
  // deterministic rather than dependent on row order.
  const current = heads.reduce<CandidateDecision | undefined>(
    (latest, decision) =>
      latest === undefined || decision.decidedAt > latest.decidedAt ? decision : latest,
    undefined
  );
  if (current === undefined) {
    // Every decision is superseded by another, which means the chain is
    // a cycle. Unrepresentable through recordCandidateDecision, but
    // reporting `undecided` beats returning an arbitrary row from a
    // structure that is already wrong.
    return { status: "undecided" };
  }
  return {
    status: current.decision,
    decidedByUserId: current.decidedByUserId,
    rationale: current.rationale,
    decidedAt: current.decidedAt,
    decisionId: current.decisionId,
    revisionCount: decisions.length - 1
  };
}

// ---- AF-52: low-evidence random audit sampling ----
//
// "Randomly sample low-ranked/low-evidence candidates for independent
// review -- this is how false negatives get caught, not by trusting the
// model's confidence."
//
// Two things about that sentence had to be resolved before any of it
// could be built.
//
// There is no "low-ranked". Nothing in this system ranks candidates:
// POL-003 forbids a scoring field, AF-46 fixes the queue to the
// employer's own file order, and AF-47's filters are a subsequence of
// that order rather than a re-sort. So the selectable population is
// defined by evidence, not position, and this module offers no way to
// order candidates by anything a reviewer could mistake for a rank. The
// half of the ticket that cannot be honoured is the half that asks for
// something the product deliberately does not have.
//
// "Not by trusting the model's confidence" is likewise structural
// rather than a promise: there is no confidence value to consult. What
// IS available is the KIND of each evidence outcome, which is a
// statement about what was found rather than how sure anything was.

/**
 * How much citable evidence an application actually carries.
 *
 * Deliberately three coarse buckets rather than a number. A number would
 * be a rank in everything but name -- someone would sort by it within a
 * week -- and it would imply a precision the underlying data does not
 * have.
 */
export type EvidenceStrength = "none" | "weak" | "cited";

export interface EvidenceStrengthSummary {
  readonly strength: EvidenceStrength;
  /** Criteria whose current outcome carries a quote a human can check. */
  readonly citedCount: number;
  /** Criteria answered, but with nothing to verify (not_found, unclear-without-citation, errors). */
  readonly uncitedCount: number;
  readonly totalCriteria: number;
}

/**
 * Uses the same card set the reviewer sees, so "low evidence" means the
 * same thing to the sampler and to the human it hands work to.
 */
export function summarizeEvidenceStrength(cards: readonly EvidenceCard[]): EvidenceStrengthSummary {
  const citedCount = cards.filter((card) => card.verifiable).length;
  const totalCriteria = cards.length;
  const uncitedCount = totalCriteria - citedCount;
  const strength: EvidenceStrength =
    citedCount === 0 ? "none" : citedCount * 2 <= totalCriteria ? "weak" : "cited";
  return { strength, citedCount, uncitedCount, totalCriteria };
}

export interface AuditSampleCandidate {
  readonly applicationId: string;
  readonly strength: EvidenceStrength;
}

export interface AuditSampleSelection {
  readonly seed: string;
  readonly eligibleCount: number;
  readonly sampledApplicationIds: readonly string[];
}

/**
 * A 32-bit FNV-1a hash. Not cryptographic and not trying to be: this
 * needs to be stable across processes, machines and language runtimes so
 * that an auditor re-running the selection six months later gets the
 * same answer, and FNV-1a is small enough to reimplement from the spec
 * if they are checking it in a different language.
 */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Selects `size` applications for independent review from those whose
 * evidence is weak or absent.
 *
 * Deterministic from the seed, not Math.random(), and that is the point
 * rather than an implementation detail. A sample nobody can reproduce
 * cannot be audited -- and one that can be silently re-rolled until it
 * looks acceptable is worse than none, because it carries the authority
 * of a random check while being a chosen one. Recording the seed
 * alongside the result (AF-52's migration) makes the selection
 * reproducible by anyone and re-rollable by no one.
 *
 * Ties break on applicationId so the order is total: two applications
 * hashing to the same bucket must not depend on input order, or the
 * "reproducible" claim quietly fails on collision.
 */
export function selectAuditSample(
  candidates: readonly AuditSampleCandidate[],
  seed: string,
  size: number
): AuditSampleSelection {
  const eligible = candidates.filter((candidate) => candidate.strength !== "cited");
  const ordered = [...eligible].sort((a, b) => {
    const left = stableHash(`${seed}:${a.applicationId}`);
    const right = stableHash(`${seed}:${b.applicationId}`);
    return left - right || a.applicationId.localeCompare(b.applicationId);
  });
  return {
    seed,
    eligibleCount: eligible.length,
    sampledApplicationIds: ordered.slice(0, Math.max(0, size)).map((candidate) => candidate.applicationId)
  };
}

// ---- AF-53: keyboard-first review navigation ----
//
// "Recruiters reviewing hundreds of applications need keyboard-driven
// navigation between cards and source context, not mouse-only review."
//
// The decision layer lives here, in a pure function, for a reason worth
// stating: this repository has no DOM test infrastructure -- no jsdom,
// no testing-library, tests run under node --test. Keyboard handling
// written directly into a component would therefore be shipped
// untested, and the parts most likely to be wrong are not the event
// plumbing but the RULES: which keys are claimed, when they are not
// claimed, and where the boundaries are. Those are decidable without a
// browser, so they are decided here and exhaustively tested, and the
// component is left as thin glue over them.

export type ReviewKeyAction =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "open"
  | "reveal-source"
  | "help"
  | "none";

export interface ReviewKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  /**
   * True when focus is inside a text field or contenteditable region.
   * The caller determines this from the DOM; this module will not guess.
   */
  readonly editingText?: boolean;
}

/**
 * Two refusals come before any binding is considered, and they matter
 * more than the bindings do.
 *
 * A shortcut that fires while a recruiter is typing a correction
 * rationale eats their input -- and AF-50 requires that rationale, so
 * the damage lands on the one field the system insists on. `editingText`
 * suppresses everything.
 *
 * A shortcut that fires with Ctrl, Meta or Alt held steals a browser or
 * operating-system binding: Cmd+K, Ctrl+F, Alt+Left. An application
 * that takes those is harder to use with a keyboard, not easier, which
 * inverts the ticket. Shift is NOT in that list on purpose -- `?` and
 * `G` require it on most layouts, so refusing Shift would refuse two of
 * the bindings below.
 */
export function resolveReviewKeyAction(event: ReviewKeyEvent): ReviewKeyAction {
  if (event.editingText === true) {
    return "none";
  }
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
    return "none";
  }
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    case "g":
    case "Home":
      return "first";
    case "G":
    case "End":
      return "last";
    case "Enter":
      return "open";
    case "s":
      return "reveal-source";
    case "?":
      return "help";
    default:
      return "none";
  }
}

/**
 * Clamped, never wrapped.
 *
 * A review queue that loops from the last candidate back to the first
 * re-presents people who have already been looked at as though they are
 * new, and gives no signal that the list ended. In a tool whose whole
 * purpose is that a human actually saw each candidate, silently
 * restarting is the wrong failure. Reaching the end and staying there
 * is legible; wrapping is not.
 */
export function nextReviewIndex(action: ReviewKeyAction, currentIndex: number, itemCount: number): number {
  if (itemCount <= 0) {
    return -1;
  }
  const clamp = (index: number): number => Math.min(Math.max(index, 0), itemCount - 1);
  switch (action) {
    case "next":
      return clamp(currentIndex + 1);
    case "previous":
      return clamp(currentIndex - 1);
    case "first":
      return 0;
    case "last":
      return itemCount - 1;
    case "open":
    case "reveal-source":
    case "help":
    case "none":
      return clamp(currentIndex);
    default:
      return clamp(currentIndex);
  }
}

export interface ReviewShortcut {
  readonly keys: readonly string[];
  readonly description: string;
}

/**
 * Published so the UI renders the same list the resolver implements,
 * rather than a hand-maintained copy that drifts. A keyboard interface
 * nobody can discover is a mouse-only interface with extra steps, so
 * this is part of the feature rather than documentation of it.
 */
export const REVIEW_SHORTCUTS: readonly ReviewShortcut[] = [
  { keys: ["j", "↓"], description: "Next" },
  { keys: ["k", "↑"], description: "Previous" },
  { keys: ["g", "Home"], description: "First" },
  { keys: ["G", "End"], description: "Last" },
  { keys: ["Enter"], description: "Open the focused item" },
  { keys: ["s"], description: "Reveal the source citation for the focused card" },
  { keys: ["?"], description: "Show these shortcuts" }
];

// ---- AF-54: capture recruiter review timing ----
//
// "Time-per-application in the review queue, needed as the baseline for
// the review-time-reduction metric."
//
// This module produces the INPUTS to a metric, not the metric. AF-60
// owns the reporting envelope -- sample size, population, suppression
// below a minimum, stated limitations -- and defines MetricSample and
// summarizeMetric for it. That branch runs parallel to this one rather
// than beneath it, so its types are not importable here yet;
// ReviewTimingSummary below is deliberately shaped to be handed
// straight to summarizeMetric when the two lines meet, and should be
// replaced by that call rather than grown its own reporting rules.

export interface ReviewTimingSpan {
  readonly applicationId: string;
  readonly activeMs: number;
  readonly truncatedByIdle: boolean;
}

export interface ReviewTimingSummary {
  /**
   * Median, not mean. A handful of interrupted reviews -- a lunch break
   * with the tab open, a call mid-candidate -- drags a mean far above
   * anything a recruiter experiences, and this number's whole job is to
   * be the honest "before" in a before/after claim. An inflated
   * baseline makes any later improvement look better than it was, which
   * is the specific way this metric could flatter the product.
   */
  readonly medianActiveMs: number | null;
  /** Applications with at least one usable span. The denominator. */
  readonly sampleSize: number;
  /** Applications in scope, whether or not they were ever opened. */
  readonly population: number;
  /** Spans excluded because an idle cutoff ended them. */
  readonly truncatedSpanCount: number;
}

/**
 * Time is summed per application across visits, then a median is taken
 * across applications -- not a median across raw spans.
 *
 * The distinction matters and is easy to get backwards. A candidate
 * opened three times for twenty seconds each took a minute to review,
 * not twenty seconds; a median over spans would report the latter and
 * understate the baseline. Summing first, then taking the median, keeps
 * "time per application" meaning what it says.
 *
 * Truncated spans are counted but NOT summed. An idle cutoff means the
 * reviewer stopped looking and we do not know when, so the span's active
 * time is a lower bound rather than a measurement. Including it would
 * bias the baseline downward -- again in the direction that flatters a
 * later improvement -- and excluding it silently would hide how much
 * data was dropped, which is why the count is reported.
 */
export function summarizeReviewTiming(
  spans: readonly ReviewTimingSpan[],
  population: number
): ReviewTimingSummary {
  const truncatedSpanCount = spans.filter((span) => span.truncatedByIdle).length;
  const usable = spans.filter((span) => !span.truncatedByIdle);

  const totalByApplication = new Map<string, number>();
  for (const span of usable) {
    totalByApplication.set(span.applicationId, (totalByApplication.get(span.applicationId) ?? 0) + span.activeMs);
  }

  const totals = [...totalByApplication.values()].sort((left, right) => left - right);
  const sampleSize = totals.length;
  return {
    // null, never 0, when there is nothing to measure. A zero would read
    // as "reviews take no time" and is the kind of number that gets
    // quoted out of its context.
    medianActiveMs: sampleSize === 0 ? null : median(totals),
    sampleSize,
    population,
    truncatedSpanCount
  };
}

function median(sortedValues: readonly number[]): number {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle] ?? 0;
  }
  const lower = sortedValues[middle - 1] ?? 0;
  const upper = sortedValues[middle] ?? 0;
  return (lower + upper) / 2;
}

// ---- AF-58: failed-document rate ----
//
// "Share of uploaded documents that failed" needs a denominator that is
// honest about what it does not yet know. A document that has arrived but
// whose validation or extraction has not run yet is not a success and not
// a failure -- counting it either way makes the rate move on its own as
// the pipeline drains, which is the opposite of a leading indicator.
//
// So the rate is over documents with a TERMINAL outcome, and everything
// still in flight is reported separately rather than folded in. AF-60
// ("show sample sizes and limitations") wants exactly this shape: the
// number, and enough context to know whether to trust it yet.

/** Raw per-role counts, as read from file_intakes joined to extractions. */
export interface FailedDocumentCounts {
  /** Intakes past 'pending': a file actually arrived. */
  readonly uploaded: number;
  readonly quarantined: number;
  readonly rejected: number;
  /** Validated, extraction ran, and produced no usable text. */
  readonly extractionEmpty: number;
  /** Validated, extraction ran, and produced full or partial text. */
  readonly extractionSucceeded: number;
}

export interface FailedDocumentRate extends VersionedRecord {
  readonly organizationId: string;
  readonly roleId: string;
  readonly uploaded: number;
  /** quarantined + rejected + extractionEmpty. */
  readonly failed: number;
  readonly quarantined: number;
  readonly rejected: number;
  readonly extractionEmpty: number;
  readonly extractionSucceeded: number;
  /** Terminal outcomes only -- the denominator of `failedRate`. */
  readonly resolved: number;
  /** Uploaded but not yet quarantined, rejected, or extracted. */
  readonly inFlight: number;
  /**
   * failed / resolved, or null when nothing has resolved yet. Null rather
   * than 0: "no documents have finished" and "no documents failed" are
   * different claims, and reporting the first as the second would make an
   * empty role look perfectly healthy.
   */
  readonly failedRate: number | null;
}

export function summarizeFailedDocuments(
  organizationId: string,
  roleId: string,
  counts: FailedDocumentCounts
): FailedDocumentRate {
  const values = [
    counts.uploaded,
    counts.quarantined,
    counts.rejected,
    counts.extractionEmpty,
    counts.extractionSucceeded
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`summarizeFailedDocuments requires non-negative integer counts, got: ${JSON.stringify(counts)}`);
  }
  const failed = counts.quarantined + counts.rejected + counts.extractionEmpty;
  const resolved = failed + counts.extractionSucceeded;
  if (resolved > counts.uploaded) {
    // Every terminal state is reached by an uploaded document, so this is
    // a contradiction in the input, not a rounding artefact. Failing here
    // beats emitting a rate above 1 or a negative inFlight.
    throw new Error(
      `summarizeFailedDocuments: resolved (${resolved}) exceeds uploaded (${counts.uploaded}); counts are inconsistent`
    );
  }
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId,
    roleId,
    uploaded: counts.uploaded,
    failed,
    quarantined: counts.quarantined,
    rejected: counts.rejected,
    extractionEmpty: counts.extractionEmpty,
    extractionSucceeded: counts.extractionSucceeded,
    resolved,
    inFlight: counts.uploaded - resolved,
    failedRate: resolved === 0 ? null : failed / resolved
  };
}

// ---- AF-60: sample sizes and limitations ----
//
// "Do not let a report imply more confidence than the sample supports."
// A bare number does that by omission: 0.6 reads the same whether it came
// from 5 resolved documents or 5,000, and a reader has no way to tell.
//
// So a reported metric is never a bare number here. It carries the
// denominator it was computed over, the population that denominator was
// drawn from, and an explicit list of the reasons it should not be read
// at face value. When the sample cannot support a value at all, `value`
// is null and a limitation says why -- the same choice AF-58 made for
// failedRate, generalised, because "we cannot tell you" and "the answer
// is zero" are different claims and only one of them is ever true of an
// empty sample.
//
// The limitation codes are a closed set rather than free text: a report
// consumer has to be able to branch on them, and prose that varies by
// call site cannot be aggregated or translated.

export const METRIC_LIMITATION_CODES = [
  /** Nothing has resolved yet; there is no denominator to divide by. */
  "no_sample",
  /** A denominator exists but is too small for the stated threshold. */
  "below_minimum_sample",
  /** Some of the population is excluded from the denominator (e.g. still in flight). */
  "population_incomplete",
  /**
   * AF-55. One side of a comparison is a figure the customer supplied
   * rather than one this system measured. Distinct from the three codes
   * above, which are all about how much data there is: this one says the
   * data is not the same KIND on both sides, and no amount of extra
   * sample fixes it.
   */
  "baseline_self_reported",
  /**
   * AF-56. Part of the ground truth was discarded because the
   * adjudicator had seen this system's output, so it could not serve as
   * an independent check. Like baseline_self_reported this is about the
   * KIND of data, not the amount -- but it is a distinct claim: that one
   * says the two sides were measured differently, this one says some of
   * the reference side was thrown away as unusable.
   */
  "adjudication_not_independent",
  /**
   * AF-57. Part of the denominator counts as examined on the strength of
   * a record about the candidate rather than about the item being
   * counted. Like the two codes above, this is about the KIND of data
   * and not the amount: the examination fact is at a coarser grain than
   * the unit of the metric, so a larger sample does not make it any more
   * certain that any single item was read.
   */
  "examination_inferred"
] as const;

export type MetricLimitationCode = (typeof METRIC_LIMITATION_CODES)[number];

export interface MetricLimitation {
  readonly code: MetricLimitationCode;
  /** Human-readable specifics, always including the numbers involved. */
  readonly detail: string;
}

export interface MetricSample extends VersionedRecord {
  readonly metric: string;
  /** null when the sample cannot support a value; never a placeholder number. */
  readonly value: number | null;
  /** The denominator the value was actually computed over. */
  readonly sampleSize: number;
  /** How many entities were in scope, whether or not they reached the denominator. */
  readonly population: number;
  /** The smallest sampleSize this metric is willing to report a value for. */
  readonly minimumSampleSize: number;
  readonly limitations: readonly MetricLimitation[];
}

export interface SummarizeMetricInput {
  readonly metric: string;
  /** The computed value, or null if the caller already knows it is unavailable. */
  readonly value: number | null;
  readonly sampleSize: number;
  readonly population: number;
  readonly minimumSampleSize: number;
}

/**
 * Suppression is deliberate, not advisory. A metric below its minimum
 * sample returns `value: null` rather than the number plus a warning,
 * because a warning beside a number is routinely dropped by whatever
 * renders it, and the number is what gets quoted. If the sample cannot
 * support the claim, the report must not be able to make it.
 */
export function summarizeMetric(input: SummarizeMetricInput): MetricSample {
  const { metric, value, sampleSize, population, minimumSampleSize } = input;
  if (metric.trim().length === 0) {
    throw new Error("summarizeMetric requires a metric name");
  }
  for (const [name, n] of [
    ["sampleSize", sampleSize],
    ["population", population],
    ["minimumSampleSize", minimumSampleSize]
  ] as const) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`summarizeMetric requires a non-negative integer ${name}, got: ${n}`);
    }
  }
  if (sampleSize > population) {
    throw new Error(
      `summarizeMetric: sampleSize (${sampleSize}) exceeds population (${population}) for ${metric}; ` +
        "the denominator cannot be larger than the set it was drawn from"
    );
  }
  if (value !== null && !Number.isFinite(value)) {
    throw new Error(`summarizeMetric: ${metric} value must be finite or null, got: ${value}`);
  }

  const limitations: MetricLimitation[] = [];
  if (sampleSize === 0) {
    limitations.push({
      code: "no_sample",
      detail: `no ${metric} observations have resolved yet (population ${population})`
    });
  } else if (sampleSize < minimumSampleSize) {
    limitations.push({
      code: "below_minimum_sample",
      detail: `${sampleSize} observations is below the minimum of ${minimumSampleSize} required to report ${metric}`
    });
  }
  if (sampleSize < population) {
    limitations.push({
      code: "population_incomplete",
      detail: `${population - sampleSize} of ${population} in scope are not yet counted toward ${metric}`
    });
  }

  const supported = sampleSize > 0 && sampleSize >= minimumSampleSize;
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    metric,
    value: supported ? value : null,
    sampleSize,
    population,
    minimumSampleSize,
    limitations
  };
}

/**
 * AF-58's failed-document rate expressed as a reportable metric. Its
 * denominator is documents with a terminal outcome, and its population is
 * every document that arrived -- so a role still draining reports
 * `population_incomplete` automatically rather than relying on whoever
 * writes the report to remember.
 */
export function describeFailedDocumentRate(
  rate: FailedDocumentRate,
  minimumSampleSize: number
): MetricSample {
  return summarizeMetric({
    metric: "failed_document_rate",
    value: rate.failedRate,
    sampleSize: rate.resolved,
    population: rate.uploaded,
    minimumSampleSize
  });
}

// ---- AF-61: retention policy ----
//
// "Default retention window for raw candidate data (e.g. 30-90 days),
// configurable per contract, applied consistently across object storage,
// canonical text, and derived indexes."
//
// "Consistently" is the whole ticket, and the honest finding is that it
// is not currently achievable. Measured against the real migrations, on
// a candidate with one document, one evidence outcome and one decision,
// the deletion paths split in two:
//
//   DELETE evidence_outcomes   -> append-only trigger rejects DELETE
//   UPDATE evidence_outcomes   -> append-only trigger rejects UPDATE too,
//                                 so the quote cannot even be redacted
//   DELETE candidate_decisions -> append-only, DELETE and UPDATE both
//   DELETE applications        -> refused by five independent constraints,
//                                 any one of which is enough: the FKs from
//                                 evidence_outcomes, candidate_decisions,
//                                 audit_sample_members and
//                                 review_timing_spans (23503), and
//                                 import_rows_check, which the FK's
//                                 ON DELETE SET NULL trips (23514)
//   DELETE file_intakes        -> FK violation from applications
//   DELETE audit_events        -> append-only, DELETE and UPDATE both
//   DELETE evidence_extraction_runs -> append-only, DELETE and UPDATE both
//
//   DELETE canonical_text_extractions -> permitted, the row goes
//   DELETE import_rows                -> permitted, the row goes
//
// So the two surfaces the ticket names directly, canonical text and a
// derived index, can be purged on time today. What cannot is the layer
// the ticket does not mention: candidate_full_name and candidate_email
// on applications, declared_filename on file_intakes, the verbatim
// quote on evidence_outcomes and the rationale on candidate_decisions.
//
// And below that, a layer that is not text at all: the application
// identifier, written into audit_events and evidence_extraction_runs
// through a polymorphic entity_type/entity_id pair. It reads as
// metadata and is not -- it is the key that re-links every surviving
// row above to one person, and both tables are append-only, so it
// cannot be removed or redacted either.
//
// Every line above is asserted against a real Postgres by
// assertRetentionPurgeBlockers, the permitted ones included. The first
// revision of this module called canonical_text_extractions and
// import_rows blocked, reasoning from their cascade through file_intakes
// and never trying the direct DELETE, and the probe is what disproved
// it. A plan that overstates what survives is wrong in the same way as
// one that understates it, which is why both directions are proved.
//
// That the blocked half is blocked is not a bug in any one migration:
// 0016_evidence_outcomes.sql is append-only because an evidence record
// that can be edited after the fact cannot serve as an audit trail, and
// it deliberately has no ON DELETE CASCADE because a cascade issues a
// DELETE that the very same trigger rejects (the AF-20 defect).
// 0019_candidate_decisions.sql repeats both decisions for the same
// stated reasons, and so do 0020_audit_samples.sql and
// 0021_review_timing.sql. Each is right on its own terms and together
// they make a complete purge unimplementable.
//
// So this module does NOT pretend to purge. It produces a plan in which
// every surface carries an explicit disposition, blocked ones say why,
// and summarizeSurvivingCandidateData reports what is still there
// afterwards -- because a privacy notice written from an optimistic
// retention policy is a false statement to a candidate, which is a
// materially worse outcome than an honest "we keep quotes indefinitely".
//
// The unblocking design is named, not built: encrypt candidate-derived
// text under a per-candidate key and delete the key at expiry. The
// append-only row survives intact, so the audit trail holds, while its
// readable content does not. That is a schema and key-management change
// well beyond this ticket and needs a human decision, so AF-61 stops at
// telling the truth about the current state.

// REV-001: two surfaces link to a candidate through a polymorphic
// entity_type/entity_id text pair rather than a foreign key, and both
// were mishandled because of it.
//
// evidence_extraction_runs (0006_evidence_extraction_runs.sql) was
// absent from this list altogether. The inventory that would have caught
// the omission reads pg_constraint, and there is no constraint to read:
// the link to an application is two text columns. A table invisible to
// the check that finds unaccounted tables is exactly the one that goes
// unaccounted for.
//
// audit_events was listed, and classified no_candidate_data. It holds no
// candidate TEXT -- AF-21's redaction and the closed context allowlist
// are real -- but entity_type and entity_id are free text constrained
// only by length > 0, and two of the four audit actions
// (evidence_corrected, decision_recorded) are per-application by
// definition. So the identifier of a candidate's application is written
// there in the ordinary course of business, and an identifier is not a
// lesser kind of candidate data for retention purposes: it is the thing
// that re-links every surviving record to a person. Both tables are
// append-only, so it can be neither deleted nor redacted.
export const RETENTION_SURFACES = [
  "object_storage_documents",
  "file_intakes",
  "canonical_text_extractions",
  "import_rows",
  "applications",
  "evidence_outcomes",
  "candidate_decisions",
  "audit_events",
  "evidence_extraction_runs",
  // The same rule one step further out. These two declare their link to
  // a candidate properly, with a composite foreign key onto
  // applications, so the reference inventory could always see them -- and
  // saw them accounted for, because the applications detail names both
  // as blockers. Being named as something that pins another surface is
  // not the same as being classified as a surface, and nothing was
  // checking for the difference. Both are append-only and both keep an
  // application identifier past any cutoff.
  "audit_sample_members",
  "review_timing_spans"
] as const;

export type RetentionSurface = (typeof RETENTION_SURFACES)[number];

export type RetentionDisposition =
  /** Can be deleted at expiry today. */
  | "purge"
  /** Holds candidate data that an append-only guarantee forbids removing. */
  | "blocked_append_only"
  /** Deletable in principle, but a foreign key from a blocked surface pins it. */
  | "blocked_by_reference"
  /** In scope for completeness; holds no candidate-derived content. */
  | "no_candidate_data";

export interface RetentionSurfacePlan {
  readonly surface: RetentionSurface;
  readonly disposition: RetentionDisposition;
  /** What candidate-derived content this surface holds, in plain words. */
  readonly holds: string;
  /** Why the disposition is what it is. Never empty for a blocked surface. */
  readonly detail: string;
}

export interface RetentionPolicy {
  readonly organizationId: string;
  readonly windowDays: number;
  /**
   * Required once the window exceeds the standard range, so an unusually
   * long retention is traceable to something someone signed rather than
   * to a config value nobody remembers setting.
   */
  readonly contractReference?: string | undefined;
}

/** The ticket's stated norm. Anything longer needs a contract reference. */
export const RETENTION_STANDARD_MAX_DAYS = 90;
/** Shortest of the stated range: a default that errs long keeps candidate data by accident. */
export const RETENTION_DEFAULT_DAYS = 30;
/** A hard ceiling, so a typo cannot become a decade. */
export const RETENTION_ABSOLUTE_MAX_DAYS = 3650;

export function validateRetentionPolicy(policy: RetentionPolicy): void {
  if (!Number.isInteger(policy.windowDays) || policy.windowDays < 1) {
    throw new Error(
      `retention windowDays must be a positive whole number of days, got: ${policy.windowDays}`
    );
  }
  if (policy.windowDays > RETENTION_ABSOLUTE_MAX_DAYS) {
    throw new Error(
      `retention windowDays ${policy.windowDays} exceeds the absolute maximum of ${RETENTION_ABSOLUTE_MAX_DAYS}`
    );
  }
  if (policy.windowDays > RETENTION_STANDARD_MAX_DAYS) {
    const reference = policy.contractReference?.trim() ?? "";
    if (reference.length === 0) {
      throw new Error(
        `a retention window of ${policy.windowDays} days exceeds the standard ` +
          `${RETENTION_STANDARD_MAX_DAYS} days and requires a contractReference`
      );
    }
  }
}

/**
 * Records created at or before this instant are past their window.
 *
 * Computed from an explicit `now` rather than reading the clock, so the
 * same policy evaluated twice in one purge run cannot straddle midnight
 * and delete a different set the second time.
 */
export function computeRetentionCutoff(policy: RetentionPolicy, now: Date): string {
  validateRetentionPolicy(policy);
  const cutoff = new Date(now.getTime() - policy.windowDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

const RETENTION_PLAN: Readonly<Record<RetentionSurface, Omit<RetentionSurfacePlan, "surface">>> = {
  object_storage_documents: {
    disposition: "purge",
    holds: "the uploaded document itself",
    detail: "Deletable by storage key; nothing in the database references the object's bytes."
  },
  file_intakes: {
    disposition: "blocked_by_reference",
    holds:
      "declared_filename, which routinely contains the candidate's name, and " +
      "storage_key, which embeds that same filename",
    detail:
      "DELETE fails with a foreign key violation from applications. The filename is easy to " +
      "overlook as PII and is often exactly 'Firstname_Lastname_CV.pdf'."
  },
  canonical_text_extractions: {
    disposition: "purge",
    holds: "the full extracted text of the candidate's document",
    detail:
      "Deletable directly by intake_id. Nothing references this table and it carries no " +
      "append-only trigger, so the row goes. It also cascades away with its file_intake, and " +
      "that route is blocked while an application references the intake, but it is not the " +
      "only route: reading the cascade alone is what previously made this surface look " +
      "blocked. The largest single store of raw candidate text, and it can go on time. " +
      "Purging it does leave the citation quotes in evidence_outcomes with no source text to " +
      "validate against, which is a consequence to accept deliberately rather than discover."
  },
  import_rows: {
    disposition: "purge",
    holds: "failure_reason, which can quote the offending row",
    detail:
      "Deletable directly by intake_id, for the same reason as canonical_text_extractions: " +
      "nothing references it and no trigger guards it. The cascade from file_intakes is " +
      "blocked, but it is not the only route. Purging it drops rows from the per-row import " +
      "ledger, so AF-32's 'every input row is accounted for' stops holding once an intake " +
      "has expired. Its processed rows are also one of the five things that pin applications, " +
      "so any purge that reaches applications has to purge import_rows first."
  },
  applications: {
    disposition: "blocked_by_reference",
    holds: "candidate_full_name, candidate_email, external_reference_id",
    detail:
      "DELETE is refused by five independent constraints, any one of which is enough on its " +
      "own. Four are uncascaded foreign keys from append-only tables, each refused with a " +
      "foreign key violation: evidence_outcomes (0016_evidence_outcomes.sql), " +
      "candidate_decisions (0019_candidate_decisions.sql), audit_sample_members " +
      "(0020_audit_samples.sql) and review_timing_spans (0021_review_timing.sql). None carries " +
      "ON DELETE CASCADE, deliberately, since a cascade issues a DELETE the append-only trigger " +
      "would reject anyway, and the same trigger stops those rows being deleted first. The " +
      "fifth is import_rows (0015_applications_and_import_finalization.sql): its foreign key " +
      "is ON DELETE SET NULL, but import_rows_check requires a processed row to keep its " +
      "application_id, so the SET NULL is refused with a check violation. Every CSV-imported " +
      "application has a processed import row, so this applies to all of them, and import_rows " +
      "must be purged before applications. Postgres names only the first refusal it meets, so " +
      "unblocking any one of these independently leaves this surface blocked by the others."
  },
  evidence_outcomes: {
    disposition: "blocked_append_only",
    holds:
      "citation quotes, which are verbatim candidate text, and correction_reason, " +
      "free text a reviewer wrote about the candidate's evidence",
    detail:
      "Both DELETE and UPDATE are rejected by the append-only trigger, so the quote cannot be " +
      "removed and cannot be redacted in place either. It is one of four append-only tables " +
      "whose foreign keys pin applications, alongside candidate_decisions, " +
      "audit_sample_members and review_timing_spans, so unblocking it alone frees nothing."
  },
  candidate_decisions: {
    disposition: "blocked_append_only",
    holds: "rationale, free text a human wrote about the candidate",
    detail:
      "Append-only for the same reason: a decision record that can be edited afterwards cannot " +
      "evidence who decided what."
  },
  audit_events: {
    disposition: "blocked_append_only",
    holds:
      "entity_id, which is a candidate's application identifier whenever entity_type is " +
      "\"application\" -- what evidence_corrected and decision_recorded record by definition",
    detail:
      "Append-only (0005_immutable_audit_events.sql): DELETE and UPDATE are both rejected, so the " +
      "identifier can be neither removed nor redacted in place. It carries no candidate TEXT -- AF-21's " +
      "redaction and the closed context allowlist keep that out, and that part of the earlier " +
      "no_candidate_data classification was right -- but entity_type and entity_id are free text " +
      "checked only for length, so nothing in the schema stops an application identifier being " +
      "written here, and two of the four audit actions are per-application by definition. An " +
      "identifier is what re-links every other surviving record to a person, so a retention statement " +
      "that counts it as nothing is claiming more deletion than happens."
  },
  audit_sample_members: {
    disposition: "blocked_append_only",
    holds: "application_id, the identifier of a candidate drawn into an audit sample",
    detail:
      "Append-only (0020_audit_samples.sql): DELETE and UPDATE are both rejected. It carries no " +
      "candidate text, only the identifier and the draw it belongs to, but the row is itself a " +
      "statement about a named candidate -- that they were selected for audit -- and it is one of " +
      "the four uncascaded foreign keys that pin applications, so it cannot go first either."
  },
  review_timing_spans: {
    disposition: "blocked_append_only",
    holds:
      "application_id, plus reviewer_user_id and the start, end and active duration of every " +
      "review of that candidate",
    detail:
      "Append-only (0021_review_timing.sql): DELETE and UPDATE are both rejected. Beyond the " +
      "identifier this is behavioural data linking a named reviewer to a named candidate at a " +
      "specific time, which is more than an aggregate input to AF-55's median. Another of the four " +
      "uncascaded foreign keys pinning applications."
  },
  evidence_extraction_runs: {
    disposition: "blocked_append_only",
    holds:
      "entity_id, an application identifier for every run this product writes " +
      "(APPLICATION_ENTITY_TYPE), alongside provider, model and version strings that are not " +
      "candidate-derived",
    detail:
      "Append-only (0006_evidence_extraction_runs.sql): DELETE and UPDATE are both rejected. Its " +
      "association with an application is the polymorphic entity_type/entity_id pair and not a " +
      "foreign key, which is why pg_constraint cannot see it and why this surface was missing from " +
      "the plan rather than merely misclassified. listEvidenceExtractionRunsForEntities queries it " +
      "by entity_type = \"application\" and a list of application identifiers, so the association is " +
      "load-bearing production behaviour rather than a possibility the schema leaves open."
  }
};

export interface RetentionPlan {
  readonly organizationId: string;
  readonly windowDays: number;
  readonly cutoff: string;
  readonly surfaces: readonly RetentionSurfacePlan[];
}

/**
 * Every surface appears, always. A surface missing from a retention plan
 * reads as "nothing to do there", which is the same failure mode as a
 * missing section in AF-59's report and has the same fix: make omission
 * unrepresentable rather than discouraged.
 */
export function planRetention(policy: RetentionPolicy, now: Date): RetentionPlan {
  return {
    organizationId: policy.organizationId,
    windowDays: policy.windowDays,
    cutoff: computeRetentionCutoff(policy, now),
    surfaces: RETENTION_SURFACES.map((surface) => ({ surface, ...RETENTION_PLAN[surface] }))
  };
}

export interface SurvivingCandidateData {
  /** True when at least one surface still holds candidate data after expiry. */
  readonly anySurvives: boolean;
  /** Echoed from the input, so whoever renders the notice can see which case it is. */
  readonly automatedDeletionActive: boolean;
  readonly surfaces: readonly RetentionSurfacePlan[];
  /**
   * A sentence a privacy notice can be written from without it becoming a
   * false statement to a candidate.
   */
  readonly statement: string;
}

export interface RetentionEnforcement {
  /**
   * Whether a purge executor is actually running for this deployment.
   * Must be read from deployment configuration, never passed as a literal
   * true: this decides whether a data subject is told their data is
   * deleted. Required with no default, so the optimistic sentence cannot be
   * reached by forgetting an argument, only by stating something false.
   */
  readonly automatedDeletionActive: boolean;
}

/**
 * REV-005: the statement describes what actually happens, not what the
 * policy would do if something enforced it. Nothing runs planRetention or
 * deletes anything on a schedule yet, so with no executor the sentence
 * says so outright, and says the data is kept past the window, rather
 * than listing survivors in a way that implies everything unlisted is
 * gone. Understating what we delete is safe; overstating it is a false
 * statement to the person whose data it is.
 *
 * The anySurvives: false branch cannot be reached through planRetention
 * today, because the plan always carries blocked surfaces, but
 * RetentionPlan is exported and a hand-built plan reaches it, so it obeys
 * the same rule and is tested rather than trusted.
 */
export function summarizeSurvivingCandidateData(
  plan: RetentionPlan,
  enforcement: RetentionEnforcement
): SurvivingCandidateData {
  const { automatedDeletionActive } = enforcement;
  const surviving = plan.surfaces.filter(
    (surface) =>
      surface.disposition === "blocked_append_only" || surface.disposition === "blocked_by_reference"
  );
  const survivorList = surviving.map((surface) => `${surface.surface} (${surface.holds})`).join("; ");
  const notEnforced =
    `Candidate data is not currently deleted automatically: no deletion process runs yet, so it is ` +
    `kept after the ${plan.windowDays}-day retention window until one does.`;

  let statement: string;
  if (!automatedDeletionActive) {
    statement =
      surviving.length === 0
        ? notEnforced
        : `${notEnforced} Even once it does, the following cannot currently be deleted: ${survivorList}.`;
  } else {
    statement =
      surviving.length === 0
        ? `Raw candidate data is deleted ${plan.windowDays} days after intake.`
        : `Raw candidate data is deleted ${plan.windowDays} days after intake, except the following, ` +
          `which is retained and cannot currently be deleted: ${survivorList}.`;
  }
  return { anySurvives: surviving.length > 0, automatedDeletionActive, surfaces: surviving, statement };
}

// ---- AF-59: role-level audit report ----
//
// "The actual pilot deliverable: time saved, preservation, precision,
// corrections, and failures for one role, in a form an employer can read
// without a login."
//
// Two properties of "without a login" drive everything here.
//
// **It is unauthenticated, so it must carry no candidate identifiers.**
// A role-level report is an aggregate by definition, and the moment one
// applicationId reaches it, a link forwarded to a recruiter's personal
// inbox has leaked a named candidate outside the tenant (POL-011). The
// report type is therefore shaped so that no candidate identifier can be
// placed in it -- AuditSampleProvenance exists precisely to strip the
// sampled ids off AF-52's selection -- rather than relying on whoever
// renders it to leave them out.
//
// **It is read without anyone present to explain it.** Every guard the
// metric tickets added lives in `limitations`, and a renderer that shows
// `value` and drops them undoes all of it: a suppressed metric would
// render as blank, and blank next to four real numbers reads as zero or
// as nothing to report. So the report holds MetricSample values whole,
// and renderRoleAuditReport prints the caveats with the number rather
// than beside it.
//
// The five figures the ticket names are REQUIRED KEYS, not an array. A
// section that is merely absent from a customer-facing report reads as
// "no problems here", which is the most expensive way this document
// could be wrong. Absent becomes an explicit "not measured" line.
//
// Deliberately NOT decided here: how the report reaches the employer.
// An unauthenticated URL is a real security design -- token lifetime,
// revocation, whether the link survives the pilot -- and belongs with
// AF-64's privacy work and a human sign-off, not inside a reporting
// helper. This module produces the artifact and says nothing about
// delivery.

export const ROLE_AUDIT_METRICS = [
  "review_time_reduction",
  "qualified_candidate_preservation",
  "evidence_precision_live_pilot",
  "failed_document_rate"
] as const;

export type RoleAuditMetric = (typeof ROLE_AUDIT_METRICS)[number];

/**
 * Metric identities a section may be filled by besides the one it is
 * named for, each with the words that carry the difference into the
 * heading the reader sees.
 *
 * AF-57 changes the precision metric's identity when its denominator
 * rests on candidate-level decisions instead of item-level proof: the
 * sample comes back named
 * `evidence_precision_live_pilot_examination_inferred` precisely so that
 * it cannot be read against the 98% target. That rename is right, and it
 * meets a report whose sections are fixed keys.
 *
 * Refusing the qualified name here looks like the strict choice and is
 * the dangerous one. A live pilot only produces the unqualified name
 * when every examined item carried a correction, which is a precision of
 * 0 by construction, so in practice the section would be permanently
 * absent -- and an absent section renders as "not measured", which reads
 * as "no problems here". That is the exact failure the required-keys
 * design exists to prevent, arrived at by being strict about a name.
 *
 * So a section accepts its own metric or a declared qualification of it,
 * and the qualification travels into the heading rather than only into a
 * note underneath it. A caveat printed below the number does not stop
 * the number being quoted; the name above it does. Anything not declared
 * here is still refused: a preservation figure under the precision key
 * remains an error.
 *
 * The heading text lives in this same table on purpose. A qualification
 * that could be declared without saying how it reads would be a
 * qualification the renderer had to invent words for, and those words
 * are the whole point of it.
 */
const ROLE_AUDIT_METRIC_QUALIFICATIONS: Readonly<
  Record<RoleAuditMetric, Readonly<Record<string, string>>>
> = {
  review_time_reduction: {},
  qualified_candidate_preservation: {},
  evidence_precision_live_pilot: {
    examination_inferred: "examination inferred, not measured item by item"
  },
  failed_document_rate: {}
};

/**
 * The heading words for the qualification a sample carries under this
 * section, or null when the sample is the metric itself.
 *
 * Throws when it is neither, which is the mislabelling check: this is
 * the one fact summarizeMetric cannot know, since it is told the name
 * and has no idea which section it will be filed under.
 */
function resolveRoleAuditQualification(
  context: string,
  metric: RoleAuditMetric,
  sampleMetric: string
): string | null {
  if (sampleMetric === metric) {
    return null;
  }
  for (const [qualifier, heading] of Object.entries(ROLE_AUDIT_METRIC_QUALIFICATIONS[metric])) {
    if (sampleMetric === `${metric}_${qualifier}`) {
      return heading;
    }
  }
  // A sample filed under the wrong key would be rendered with the wrong
  // heading -- a preservation figure labelled as precision is worse than
  // a missing one, because it is believable.
  throw new Error(`${context}: metrics.${metric} carries a sample for "${sampleMetric}"`);
}

/**
 * AF-52's selection with the sampled application ids removed.
 *
 * The employer needs to see that the sample was drawn honestly -- the
 * seed makes it reproducible and eligibleCount shows what it was drawn
 * from -- and needs none of the identities to see that. Constructed by a
 * function rather than assembled at call sites so there is exactly one
 * place where the ids are dropped.
 */
export interface AuditSampleProvenance {
  readonly seed: string;
  readonly eligibleCount: number;
  readonly sampledCount: number;
}

export function describeAuditSampleProvenance(selection: AuditSampleSelection): AuditSampleProvenance {
  const distinct = new Set(selection.sampledApplicationIds);
  if (distinct.size !== selection.sampledApplicationIds.length) {
    // This is the last place the ids exist. sampledCount is published
    // beside a claim that re-running the draw reproduces the sample, and
    // a repeated id counts one candidate twice -- so the published count
    // no longer matches anything a reproducer can arrive at, and every
    // stage after this one has lost the evidence needed to notice. The
    // store rejects it too: audit_sample_members is UNIQUE on
    // (audit_sample_id, application_id).
    throw new Error(
      "describeAuditSampleProvenance: the selection repeats an application id, so sampledCount would overstate the draw"
    );
  }
  return {
    seed: selection.seed,
    eligibleCount: selection.eligibleCount,
    sampledCount: distinct.size
  };
}

/**
 * The correction figures AF-57 produces, without the precision rate.
 *
 * `examinedItems`, not `reviewedItems`. It is the same denominator the
 * precision metric is computed over, and AF-57 stopped calling that
 * "reviewed" because nothing in this system records that a human read a
 * given item: an item counts as examined by naming the record that
 * establishes it, which for a live pilot is usually a decision taken on
 * the whole candidate. Printing "reviewed evidence items" to an employer
 * re-asserts in prose the exact fact the metric's name was changed to
 * stop asserting, two lines below the heading that now says examination
 * was inferred. The section immediately above carries what the word
 * rests on, so this one only has to stop overclaiming.
 */
export interface CorrectionSummary {
  readonly examinedItems: number;
  readonly correctedItems: number;
  readonly correctionEvents: number;
}

export interface RoleAuditReport extends VersionedRecord {
  readonly organizationId: string;
  readonly roleId: string;
  readonly generatedAt: string;
  /** Every named metric, present as null when it was never computed. */
  readonly metrics: Readonly<Record<RoleAuditMetric, MetricSample | null>>;
  readonly corrections: CorrectionSummary | null;
  readonly auditSample: AuditSampleProvenance | null;
}

export interface BuildRoleAuditReportInput {
  readonly organizationId: string;
  readonly roleId: string;
  readonly generatedAt: string;
  readonly metrics: Readonly<Record<RoleAuditMetric, MetricSample | null>>;
  readonly corrections: CorrectionSummary | null;
  readonly auditSample: AuditSampleProvenance | null;
}

/**
 * Every figure this report prints has to survive a reader with no one
 * present to explain it, so each one is checked here before it can be
 * published.
 *
 * The metrics do not need it: summarizeMetric is a real constructor and
 * refuses a non-integer count, a sampleSize above its population and a
 * non-finite value, so the only thing left for this boundary to check is
 * the one fact the constructor cannot know, which key the sample was
 * filed under. CorrectionSummary and AuditSampleProvenance had no such
 * constructor -- they are bare interfaces assembled at the call site --
 * and so reached the renderer with nothing checked at all.
 */
function assertPublishableCounts(context: string, counts: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${context} requires a non-negative integer ${name}, got: ${value}`);
    }
  }
}

export function buildRoleAuditReport(input: BuildRoleAuditReportInput): RoleAuditReport {
  for (const metric of ROLE_AUDIT_METRICS) {
    const sample = input.metrics[metric];
    if (sample !== null) {
      // Throws unless the sample is this metric or a declared
      // qualification of it.
      resolveRoleAuditQualification("buildRoleAuditReport", metric, sample.metric);
    }
  }

  const corrections = input.corrections;
  if (corrections !== null) {
    assertPublishableCounts("buildRoleAuditReport: corrections", {
      examinedItems: corrections.examinedItems,
      correctedItems: corrections.correctedItems,
      correctionEvents: corrections.correctionEvents
    });
    if (corrections.correctedItems > corrections.examinedItems) {
      throw new Error(
        "buildRoleAuditReport: correctedItems cannot exceed examinedItems"
      );
    }
    if (corrections.correctionEvents < corrections.correctedItems) {
      // Correcting an item is what produces a correction event, so events
      // below corrected items is not a small discrepancy: one of the two
      // numbers is measuring something other than what the report says it
      // is, and the reader has no way to tell which.
      throw new Error(
        `buildRoleAuditReport: ${corrections.correctionEvents} correction event(s) cannot account for ` +
          `${corrections.correctedItems} corrected item(s); correcting an item takes at least one event`
      );
    }
    const precision = input.metrics.evidence_precision_live_pilot;
    if (precision !== null && precision.sampleSize !== corrections.examinedItems) {
      // Both figures are AF-57's, over one set of examined items, and the
      // report prints both: "(from N of M)" under Evidence precision and
      // "x of N examined evidence items" under Corrections. Two different
      // N's is a document that contradicts itself, and a reader who
      // divides the corrections line gets a precision that is not the one
      // printed above it.
      throw new Error(
        `buildRoleAuditReport: corrections cover ${corrections.examinedItems} examined item(s) but ` +
          `evidence_precision_live_pilot was computed over ${precision.sampleSize}; the report would print ` +
          "two different denominators for the same set"
      );
    }
  }

  const auditSample = input.auditSample;
  if (auditSample !== null) {
    assertPublishableCounts("buildRoleAuditReport: auditSample", {
      eligibleCount: auditSample.eligibleCount,
      sampledCount: auditSample.sampledCount
    });
    if (auditSample.seed.trim().length === 0) {
      // The report prints the seed as the thing that makes the draw
      // checkable. A blank one is printed just the same and explains
      // nothing, which is why audit_samples CHECKs it in the store.
      throw new Error(
        "buildRoleAuditReport: the audit sample seed cannot be blank; it is what makes the draw reproducible"
      );
    }
    if (auditSample.sampledCount > auditSample.eligibleCount) {
      // The report tells the reader that re-running the selection with
      // this seed reproduces this sample. A draw larger than the set it
      // came from cannot be reproduced by anyone, so the report would be
      // inviting a check that is guaranteed to fail and calling that
      // provenance.
      throw new Error(
        `buildRoleAuditReport: the audit sample claims ${auditSample.sampledCount} of ` +
          `${auditSample.eligibleCount} eligible candidates; a draw cannot exceed what it was drawn from`
      );
    }
  }

  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: input.organizationId,
    roleId: input.roleId,
    generatedAt: input.generatedAt,
    metrics: { ...input.metrics },
    corrections: input.corrections,
    auditSample: input.auditSample
  };
}

const ROLE_AUDIT_METRIC_HEADINGS: Readonly<Record<RoleAuditMetric, string>> = {
  review_time_reduction: "Review time saved",
  qualified_candidate_preservation: "Qualified candidates preserved",
  evidence_precision_live_pilot: "Evidence precision",
  failed_document_rate: "Documents that could not be processed"
};

function formatPercentage(value: number): string {
  // One decimal place, and the sign kept: a negative review-time
  // reduction means the tool made review slower, and dropping the sign
  // would turn the most important result this report can carry into its
  // opposite.
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Plain text, because the audience reads it without a login and quite
 * possibly without a browser that renders our CSS.
 *
 * A suppressed metric prints "not enough data to report" and its reason.
 * It never prints an empty value: blank beside four real numbers reads
 * as zero, and zero is a claim.
 */
export function renderRoleAuditReport(report: RoleAuditReport): string {
  const lines: string[] = [
    `Evidence audit report`,
    `Role: ${report.roleId}`,
    `Generated: ${report.generatedAt}`,
    ``
  ];

  for (const metric of ROLE_AUDIT_METRICS) {
    const sample = report.metrics[metric];
    if (sample === null) {
      lines.push(`${ROLE_AUDIT_METRIC_HEADINGS[metric]}`);
      lines.push(`  Not measured for this role.`);
      lines.push(``);
      continue;
    }
    // Re-resolved here rather than trusted from buildRoleAuditReport.
    // RoleAuditReport is an interface, so a caller can assemble one
    // directly, and this is the boundary where a wrong name becomes a
    // wrong heading in front of an employer.
    const qualification = resolveRoleAuditQualification("renderRoleAuditReport", metric, sample.metric);
    lines.push(
      qualification === null
        ? `${ROLE_AUDIT_METRIC_HEADINGS[metric]}`
        : `${ROLE_AUDIT_METRIC_HEADINGS[metric]} (${qualification})`
    );
    lines.push(
      sample.value === null
        ? `  Not enough data to report.`
        : `  ${formatPercentage(sample.value)} (from ${sample.sampleSize} of ${sample.population})`
    );
    for (const limitation of sample.limitations) {
      lines.push(`  Note: ${limitation.detail}`);
    }
    lines.push(``);
  }

  lines.push(`Corrections`);
  if (report.corrections === null) {
    lines.push(`  Not measured for this role.`);
  } else {
    lines.push(
      `  ${report.corrections.correctedItems} of ${report.corrections.examinedItems} examined evidence items ` +
        `were corrected, across ${report.corrections.correctionEvents} correction(s).`
    );
  }
  lines.push(``);

  lines.push(`Audit sample`);
  if (report.auditSample === null) {
    lines.push(`  No audit sample was drawn for this role.`);
  } else {
    lines.push(
      `  ${report.auditSample.sampledCount} of ${report.auditSample.eligibleCount} eligible candidates, ` +
        `drawn with seed ${report.auditSample.seed}.`
    );
    // The seed is a reconstruction key, not just a provenance label:
    // anyone who ALSO holds this role's candidate list can recompute
    // exactly which candidates were sampled -- verified, not assumed.
    // That is precisely what makes the draw auditable for the employer,
    // whose data it is, and it is inert for a stranger holding neither.
    // But it means the report is not safe to hand to a third party with
    // an overlapping candidate set, which is a plausible thing to do with
    // a pilot report. Said here rather than only in a ticket, because the
    // person choosing who to forward this to is the person reading it.
    lines.push(
      `  Anyone holding this role's candidate list can re-run the selection with that seed and ` +
        `reproduce the same sample. That is what makes the draw auditable -- and why this report ` +
        `should not be forwarded to a party that holds candidate data of its own.`
    );
  }

  return lines.join("\n") + "\n";
}

// ---- AF-57: evidence precision / correction rate ----
//
// "Share of evidence items a recruiter had to correct. Target >= 98%
// precision on live pilots (99% on the locked offline eval)."
//
// **The denominator is items a human actually looked at, and that is the
// whole ticket.** Measured over every item produced, precision rises by
// generating more evidence nobody reads -- the metric would improve
// fastest when the product was working least. An uncorrected item nobody
// examined is not evidence of precision; it is evidence of nothing. So
// unreviewed items stay in `population` and out of `sampleSize`, which
// makes summarizeMetric emit population_incomplete on its own and keeps
// the size of the unread pile visible next to the number it would
// otherwise have inflated.
//
// **Live pilots and the locked offline eval are never pooled.** The
// ticket sets two different targets, which only means anything if they
// are two populations. Pooling them lets a large, clean offline eval
// mask live-pilot errors -- and the offline set is exactly the one that
// can be grown cheaply. There is deliberately no function here that
// accepts both at once.
//
// Which dataset an item came from is a property of the item, not an
// argument supplied at the end. The first version of this took the
// dataset only where the metric name was chosen, and checked it against
// the examination source: `candidate_decision` belongs to a live pilot,
// `offline_annotation` to the locked eval. That catches nothing for the
// source that matters, because `item_correction` is the one examination
// record both worlds produce -- a recruiter correcting a card and an
// annotator marking an item wrong leave the same shape of revision
// chain. So a batch of live-pilot corrections could be reported under
// the offline name, and the inverse too: precisely the pooling the two
// targets exist to prevent, with the number carrying no trace of it.
// Every history now names its dataset, every item in a batch has to
// agree with it, and the sample takes its name from that rather than
// from a second argument nothing cross-checks.
//
// **An item enters the denominator only by naming what proves a human
// examined it.** The first version of this took a bare
// `reviewed: boolean`, which asks the caller to assert the single fact
// the metric cannot check and this stack does not record. Nothing
// records it: evidence_outcomes (0016_evidence_outcomes.sql) stores what
// was produced and what was corrected, candidate_decisions
// (0019_candidate_decisions.sql), audit_sample_members
// (0020_audit_samples.sql) and review_timing_spans
// (0021_review_timing.sql) are all per application, and AF-53's focused
// card index never leaves the browser. A bare boolean lets a caller
// count items nobody opened and inflate precision, with the emitted
// sample saying nothing about it.
//
// Narrowing the denominator to item-level proof is not the way out: a
// correction is the only item-level record there is, so a denominator
// made only of proven examinations is a denominator of corrected items,
// and the metric would report 0 for ever. So the flag is replaced by the
// fact behind it, and the weakest fact in the denominator is carried out
// with the number. A correction proves the item it lands on was
// examined. A locked-eval annotation proves it too, because every case
// in evals/datasets/gold-set-v1.json carries an expected kind per
// criterion, so each item was adjudicated one at a time. A decision
// recorded on the candidate proves only that the candidate was handled:
// it covers every item on that candidate at once, and it is all that is
// available for the common case of an item a reviewer read and left
// alone. Those still count -- excluding them is the always-0 metric
// above -- but they attach `examination_inferred`, so what the
// denominator rests on is machine-readable rather than a doc comment
// nobody reads. Expect that code on every live-pilot sample until
// something records per-item examination. That is the honest state of
// the data, not noise.

export type EvidencePrecisionDataset = "live_pilot" | "locked_offline_eval";

export const EVIDENCE_EXAMINATION_SOURCES = [
  /** Nobody is known to have looked at this item. It stays out of the denominator. */
  "not_examined",
  /**
   * The item's own revision chain carries a human correction
   * (0017_evidence_corrections.sql). Item-level proof, and the only kind
   * a live pilot produces today. It says nothing about which dataset the
   * item came from: both worlds correct items, and the chains are
   * indistinguishable. That is why the dataset is carried separately.
   */
  "item_correction",
  /**
   * A locked-eval annotator labelled this item. Item-level proof, since
   * an expected kind is recorded per criterion rather than per case, and
   * it exists only for the offline dataset.
   */
  "offline_annotation",
  /**
   * A decision was recorded on the candidate (0019_candidate_decisions.sql).
   * That the candidate was handled, not that this item was read: one
   * decision covers every item on the candidate at once. An inference,
   * counted but declared.
   */
  "candidate_decision"
] as const;

export type EvidenceExaminationSource = (typeof EVIDENCE_EXAMINATION_SOURCES)[number];

export interface EvidenceItemHistory {
  /** Stable identity across corrections: the root of the revision chain. */
  readonly itemId: string;
  /**
   * Which population this item belongs to. Caller-asserted like
   * `examinedVia`, and for the same reason: nothing in a revision chain
   * distinguishes a pilot correction from an eval one. Stating it per
   * item is what makes a mixed batch detectable at all, since a single
   * dataset argument agrees with itself no matter what it is handed.
   */
  readonly dataset: EvidencePrecisionDataset;
  /** Every revision of this one item, in any order. */
  readonly revisions: readonly EvidenceRevision[];
  /**
   * What establishes that a human examined this item. Deliberately not a
   * boolean: examination is asserted by the caller and cannot be checked
   * here, so the assertion has to name the record it rests on and carry
   * that record's weakness into the reported sample.
   */
  readonly examinedVia: EvidenceExaminationSource;
}

export interface EvidencePrecision {
  /**
   * The one population these items came from. Carried through rather
   * than restated at reporting time, so the metric name cannot disagree
   * with the data it was computed over.
   */
  readonly dataset: EvidencePrecisionDataset;
  /** 1 - (corrected / examined). null when nothing has been examined. */
  readonly precision: number | null;
  /** Items a human examined: the denominator. */
  readonly examinedItems: number;
  /** Examined items that needed at least one correction. */
  readonly correctedItems: number;
  /** Items produced, examined or not: the population. */
  readonly producedItems: number;
  /**
   * Denominator items counted as examined because a decision was
   * recorded on the candidate, with nothing recorded against the item.
   * Drives `examination_inferred`.
   */
  readonly inferredExaminations: number;
  /**
   * Corrections applied across examined items, counting repeats. Reported
   * beside correctedItems rather than folded into it: an item corrected
   * three times is one imprecise item for this metric, but three
   * corrections is a different and worse story than one, and only the
   * pair distinguishes them.
   */
  readonly correctionEvents: number;
}

/**
 * An item corrected repeatedly counts once.
 *
 * Counting correction events instead would let a single stubborn item
 * push the rate below any target on its own, and the number would stop
 * meaning "share of items" while still being named that.
 *
 * `examinedVia` has to agree with the revisions in both directions. A
 * correction is a human act, so an item carrying one was examined by
 * definition and cannot be attributed to anything weaker; and an item
 * with no correction cannot claim `item_correction`, which is the only
 * way a caller could otherwise assert item-level proof for an item no
 * record covers. Both are contradictory input rather than edge cases:
 * each hides a bug in whatever built the histories, and that bug moves
 * the denominator.
 *
 * `dataset` is required and every item must match it. Pooling is caught
 * here, where the items are, rather than at reporting time, where all
 * that is left of them is a count: by then a live-pilot correction and
 * an offline one are the same integer.
 */
export function summarizeEvidencePrecision(
  items: readonly EvidenceItemHistory[],
  dataset: EvidencePrecisionDataset
): EvidencePrecision {
  const seen = new Set<string>();
  let examinedItems = 0;
  let correctedItems = 0;
  let correctionEvents = 0;
  let inferredExaminations = 0;

  for (const item of items) {
    if (item.dataset !== dataset) {
      // The live pilot and the locked eval answer to different targets,
      // so an item counted into the wrong one is not a mislabelled row:
      // it is the pooling this metric is split in two to prevent.
      throw new Error(
        `summarizeEvidencePrecision: item ${item.itemId} belongs to ${item.dataset} ` +
          `and cannot be counted into a ${dataset} sample`
      );
    }
    if (item.examinedVia === "offline_annotation" && dataset !== "locked_offline_eval") {
      throw new Error(
        `summarizeEvidencePrecision: item ${item.itemId} claims examinedVia offline_annotation ` +
          `in a ${dataset} sample; only the locked eval has annotators`
      );
    }
    if (item.examinedVia === "candidate_decision" && dataset !== "live_pilot") {
      throw new Error(
        `summarizeEvidencePrecision: item ${item.itemId} claims examinedVia candidate_decision ` +
          `in a ${dataset} sample; only a live pilot has recruiters deciding on candidates`
      );
    }
    if (seen.has(item.itemId)) {
      // Two histories for one item would double-count it in both
      // numerator and denominator -- not cancelling out, because only one
      // of them may carry the correction.
      throw new Error(`summarizeEvidencePrecision received two histories for item ${item.itemId}`);
    }
    seen.add(item.itemId);

    const corrections = item.revisions.filter(
      (revision) => revision.supersedesEvidenceOutcomeId !== undefined
    ).length;

    if (corrections > 0 && item.examinedVia !== "item_correction") {
      throw new Error(
        `summarizeEvidencePrecision: item ${item.itemId} has ${corrections} correction(s), ` +
          `which is item-level proof of examination, but claims examinedVia ${item.examinedVia}`
      );
    }
    if (corrections === 0 && item.examinedVia === "item_correction") {
      throw new Error(
        `summarizeEvidencePrecision: item ${item.itemId} claims examinedVia item_correction ` +
          "but none of its revisions supersedes another"
      );
    }
    if (item.examinedVia === "not_examined") {
      continue;
    }
    examinedItems += 1;
    correctionEvents += corrections;
    if (corrections > 0) {
      correctedItems += 1;
    }
    if (item.examinedVia === "candidate_decision") {
      inferredExaminations += 1;
    }
  }

  return {
    dataset,
    // null, never 1. Perfect precision over an empty denominator is what
    // a pilot that has not started yet would report, and it is the single
    // most quotable wrong number this metric could produce.
    precision: examinedItems === 0 ? null : (examinedItems - correctedItems) / examinedItems,
    examinedItems,
    correctedItems,
    producedItems: items.length,
    inferredExaminations,
    correctionEvents
  };
}

/**
 * Precision as a reportable metric, for one dataset at a time.
 *
 * `population` is every item produced and `sampleSize` is only those
 * examined, so an unread backlog surfaces as population_incomplete
 * without anyone having to remember to mention it.
 *
 * A denominator resting on candidate-level decisions is reported, with
 * `examination_inferred` attached. Suppressing the number instead would
 * suppress every live-pilot figure this product can currently produce,
 * and a metric nobody can compute is not a safer metric: it is the same
 * claim made in a slide deck with nothing attached to it at all.
 *
 * There is deliberately no dataset argument. The dataset arrived with
 * the items and was checked against every one of them; taking it again
 * here would create a second place to state it and therefore a way for
 * the two to disagree, which is the same reasoning that keeps a
 * candidate's workflow status out of a column on applications
 * (0019_candidate_decisions.sql). A sample reported under the wrong name
 * is not rejected here because it cannot be constructed.
 */
export function describeEvidencePrecision(
  precision: EvidencePrecision,
  minimumSampleSize: number
): MetricSample {
  // REV-001: the metric's NAME is what makes it comparable to AF-57's 98%
  // target. A denominator built partly from candidate-level decisions is
  // not measured item examination, and attaching a limitation to a figure
  // still called evidence_precision_live_pilot does not stop anyone
  // reading it as one: a caveat travels in prose and the number travels in
  // a slide.
  //
  // So the identity changes with the denominator. When any item counts as
  // examined only because a decision was recorded on the candidate, this
  // reports as evidence_precision_<dataset>_examination_inferred, which
  // has no target to be measured against and cannot be mistaken for the
  // one that does.
  //
  // Suppressing the value outright was the alternative and is worse: it
  // would suppress every live-pilot figure this product can currently
  // produce, and a metric nobody can compute is not a safer metric, it is
  // the same claim made with nothing attached to it at all. Renaming keeps
  // the signal and removes the false equivalence, which is the actual
  // defect.
  const inferred = precision.inferredExaminations > 0;
  const sample = summarizeMetric({
    metric: inferred
      ? `evidence_precision_${precision.dataset}_examination_inferred`
      : `evidence_precision_${precision.dataset}`,
    value: precision.precision,
    sampleSize: precision.examinedItems,
    population: precision.producedItems,
    minimumSampleSize
  });

  if (!inferred) {
    return sample;
  }
  // Attached even when the value is suppressed, for the reason AF-55
  // gives: this describes how the denominator was built, not how large
  // it is, and a caveat that appeared and vanished with sample size
  // would read as being about sample size.
  return {
    ...sample,
    limitations: [
      ...sample.limitations,
      {
        code: "examination_inferred",
        detail:
          `${precision.inferredExaminations} of ${precision.examinedItems} item(s) in the denominator ` +
          "count as examined because a decision was recorded on the candidate, not because anything " +
          "records that this item was read; nothing in this system captures per-item examination, so an " +
          "item a reviewer scrolled past is indistinguishable here from one they checked and accepted"
      }
    ]
  };
}

// ---- AF-56: qualified-candidate preservation ----
//
// "Percentage of independently-adjudicated strong candidates who were
// also surfaced by the evidence workflow. Target >= 95%; this is the
// North Star safety metric."
//
// This is the number that catches the product doing the one thing it
// must never do: losing someone who should have been seen. Everything
// below is shaped so that it cannot be made to look good by accident.
//
// **Surfacing is not the same as advancing, and must not be read from
// decisions.** The tempting implementation uses AF-51's `advance`
// decisions as the surfacing signal, because that data is right there.
// It would be wrong in the most dangerous direction: it measures
// recruiters rather than the workflow, so a badly broken pipeline scores
// 100% on any week recruiters happened to advance the right people, and
// a working one is punished whenever a human disagrees with the
// adjudicator. A human declining a strong candidate is a real finding
// and a different metric; the workflow did its job the moment it put
// that candidate in front of them with evidence to read.
//
// **Independence is load-bearing, so it is represented rather than
// assumed.** An adjudicator who saw our ranking is not ground truth; the
// resulting number measures agreement with ourselves. Those
// adjudications are dropped from the denominator, not down-weighted, and
// the count is reported -- a wholly contaminated set therefore yields a
// suppressed metric rather than a flattering one.

export type AdjudicationVerdict = "strong" | "not_strong";

export interface CandidateAdjudication {
  readonly applicationId: string;
  readonly verdict: AdjudicationVerdict;
  /**
   * Whether the adjudicator reached this verdict without seeing the
   * workflow's output. Required, with no default: a default would be
   * chosen once here and thereafter every adjudication of unknown
   * provenance would silently acquire it.
   */
  readonly blindToWorkflowOutput: boolean;
}

export interface SurfacedCandidate {
  readonly applicationId: string;
  /**
   * What the reviewer actually got. `null` when the workflow reached
   * this candidate but produced no evidence at all.
   */
  readonly evidence: EvidenceStrengthSummary | null;
}

export interface QualifiedPreservation {
  /** Preserved / adjudicated strong, over independent adjudications only. */
  readonly preservationRate: number | null;
  /** Independent strong adjudications: the denominator. */
  readonly adjudicatedStrong: number;
  /** Strong candidates the workflow surfaced with something to check. */
  readonly preserved: number;
  /**
   * Reached review, but with nothing verifiable attached. Counted as a
   * miss: a name with no evidence is not what "surfaced by the evidence
   * workflow" claims, and treating it as a save would let a total
   * extraction failure report 100% preservation.
   */
  readonly missedWithoutEvidence: number;
  /** Never reached review at all -- lost upstream of the reviewer. */
  readonly missedAbsent: number;
  /** Strong adjudications discarded because the adjudicator was not blind. */
  readonly excludedNotIndependent: number;
}

/**
 * The two miss categories are kept apart deliberately. `missedAbsent`
 * is an intake or pipeline loss and `missedWithoutEvidence` is an
 * extraction-quality loss; they are fixed by different work, and a
 * single "5% missed" figure tells nobody which. Collapsing them is the
 * difference between a metric that reports and one that is actionable.
 */
export function summarizeQualifiedPreservation(
  adjudications: readonly CandidateAdjudication[],
  surfaced: readonly SurfacedCandidate[]
): QualifiedPreservation {
  const seen = new Set<string>();
  for (const adjudication of adjudications) {
    if (seen.has(adjudication.applicationId)) {
      // Two verdicts for one candidate is not a tie to break: it would
      // double-count that candidate in the denominator and silently
      // reweight the metric toward whoever was adjudicated twice.
      throw new Error(
        `summarizeQualifiedPreservation received two adjudications for ${adjudication.applicationId}`
      );
    }
    seen.add(adjudication.applicationId);
  }

  const evidenceByApplication = new Map<string, EvidenceStrengthSummary | null>();
  for (const candidate of surfaced) {
    evidenceByApplication.set(candidate.applicationId, candidate.evidence);
  }

  const strong = adjudications.filter((adjudication) => adjudication.verdict === "strong");
  const independent = strong.filter((adjudication) => adjudication.blindToWorkflowOutput);

  let preserved = 0;
  let missedWithoutEvidence = 0;
  let missedAbsent = 0;
  for (const adjudication of independent) {
    if (!evidenceByApplication.has(adjudication.applicationId)) {
      missedAbsent += 1;
      continue;
    }
    const evidence = evidenceByApplication.get(adjudication.applicationId) ?? null;
    if (evidence === null || evidence.strength === "none") {
      missedWithoutEvidence += 1;
      continue;
    }
    preserved += 1;
  }

  return {
    // null, never 1. An empty denominator means nothing was checked, and
    // a metric whose safest-looking value is what you get for doing no
    // work is worse than no metric.
    preservationRate: independent.length === 0 ? null : preserved / independent.length,
    adjudicatedStrong: independent.length,
    preserved,
    missedWithoutEvidence,
    missedAbsent,
    excludedNotIndependent: strong.length - independent.length
  };
}

/**
 * Preservation as a reportable metric.
 *
 * `population` is every strong adjudication and `sampleSize` is only the
 * independent ones, so discarding contaminated ground truth shows up as
 * a shrunken denominator on its own. The explicit limitation is still
 * attached, because `population_incomplete` reads as "not yet counted"
 * and these will never be counted.
 */
export function describeQualifiedPreservation(
  preservation: QualifiedPreservation,
  minimumSampleSize: number
): MetricSample {
  const sample = summarizeMetric({
    metric: "qualified_candidate_preservation",
    value: preservation.preservationRate,
    sampleSize: preservation.adjudicatedStrong,
    population: preservation.adjudicatedStrong + preservation.excludedNotIndependent,
    minimumSampleSize
  });
  if (preservation.excludedNotIndependent === 0) {
    return sample;
  }
  return {
    ...sample,
    limitations: [
      ...sample.limitations,
      {
        code: "adjudication_not_independent",
        detail:
          `${preservation.excludedNotIndependent} strong adjudication(s) were excluded because the ` +
          "adjudicator had seen the workflow's output; a verdict formed with our ranking in view " +
          "measures agreement with ourselves rather than checking us"
      }
    ]
  };
}

// ---- AF-55: review-time reduction ----
//
// "Compare assisted review time against the employer's own baseline
// process. Target >= 50%."
//
// This is the headline number of the whole product, which makes it the
// number most worth making hard to overstate. Two things about it are
// structurally awkward and are represented here rather than explained
// in a slide footnote.
//
// First, the two sides are not measured the same way. The assisted
// figure is instrumented: focused milliseconds, idle time excluded,
// summed per application (AF-54). The baseline is usually the employer
// telling us what they think their old process cost. Those are not
// like for like, and the difference runs one way -- a remembered "about
// fifteen minutes a CV" includes interruptions our number deliberately
// excludes. So the comparison flatters us by default, and the source of
// the baseline travels with the result instead of being forgotten.
//
// Second, the target is 50%. A threshold attached to a metric creates
// pressure to report a number that clears it, so nothing here takes a
// target as an argument or returns a pass/fail: this module reports the
// reduction and refuses to report one it cannot support. Whether the
// number cleared a bar is a separate question asked by whoever is
// entitled to ask it.

export const REVIEW_TIME_BASELINE_SOURCES = [
  /**
   * The employer's own account of their pre-assist process. An estimate,
   * not a measurement, and usually a generous one.
   */
  "employer_reported",
  /**
   * Timing spans this system recorded before assisted review was turned
   * on for the role. Measured the same way as the assisted side.
   */
  "measured_preassist"
] as const;

export type ReviewTimeBaselineSource = (typeof REVIEW_TIME_BASELINE_SOURCES)[number];

export interface ReviewTimeBaseline {
  readonly source: ReviewTimeBaselineSource;
  /** Median time per application under the employer's prior process. */
  readonly medianActiveMs: number;
}

/**
 * Assisted review time against a baseline, as a reportable metric.
 *
 * The value is the fraction of baseline time removed: 0.5 means half the
 * time, 1 would mean instant, and it is deliberately allowed to go
 * NEGATIVE when assisted review is slower. Clamping at zero is the
 * obvious defensive move and it would be the wrong one -- "we made
 * review 20% slower" is the single most important thing this metric can
 * ever say, and a floor at zero would render it as "no improvement" and
 * lose it.
 *
 * The denominator handed to summarizeMetric is applications with usable
 * timing, not spans. AF-54 drops idle-truncated spans, so an application
 * whose only visit was truncated never reaches the sample -- which shows
 * up as `population_incomplete` rather than quietly shrinking the base
 * the median was drawn from.
 */
export function describeReviewTimeReduction(
  assisted: ReviewTimingSummary,
  baseline: ReviewTimeBaseline,
  minimumSampleSize: number
): MetricSample {
  if (!Number.isFinite(baseline.medianActiveMs) || baseline.medianActiveMs <= 0) {
    // Not a suppressed metric but a throw: a zero or negative baseline
    // makes the ratio meaningless rather than unavailable, and returning
    // `value: null` here would hide a caller bug behind the same
    // "insufficient data" banner that honest small samples get.
    throw new Error(
      `describeReviewTimeReduction requires a positive baseline medianActiveMs, got: ${baseline.medianActiveMs}`
    );
  }

  const assistedMedian = assisted.medianActiveMs;
  const sample = summarizeMetric({
    metric: "review_time_reduction",
    value:
      assistedMedian === null
        ? null
        : (baseline.medianActiveMs - assistedMedian) / baseline.medianActiveMs,
    sampleSize: assisted.sampleSize,
    population: assisted.population,
    minimumSampleSize
  });

  if (baseline.source !== "employer_reported") {
    return sample;
  }
  // Attached even when the value is suppressed. The caveat is a property
  // of how the comparison was constructed, not of whether this
  // particular sample happened to be big enough, and a reader who sees
  // the limitation appear and disappear with sample size would
  // reasonably conclude it was about sample size.
  return {
    ...sample,
    limitations: [
      ...sample.limitations,
      {
        code: "baseline_self_reported",
        detail:
          `the ${baseline.medianActiveMs}ms baseline is the employer's own estimate of their prior process, ` +
          "not a measurement taken by this system; it likely includes interruptions that the assisted " +
          "figure excludes, which biases the comparison in favour of a larger reduction"
      }
    ]
  };
}
