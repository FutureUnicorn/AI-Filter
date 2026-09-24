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
//
// organizationId is on every kind, not just the citing ones: an outcome
// with no tenant attached cannot be safely attributed or isolated once
// two employers happen to use the same criterionId (docs/PRODUCT_BOUNDARY.md's
// tenant-ownership invariant). candidateId is likewise on every kind: an
// employer applies the same criterionId to many candidates, so without a
// candidate identifier two candidates' outcomes for the same criterion are
// indistinguishable -- organizationId alone only solves cross-tenant mixups,
// not cross-candidate ones within a single tenant.
//
// Every interface below also intersects Omit<NoExtraEvidenceFields, ...>
// (defined right after VersionedRecord): TypeScript only excess-property-
// checks *fresh object literals*, so a variable already typed as one kind
// (or a value an adapter's mapping function returns) can be assigned to
// the wider EvidenceOutcome union while still structurally carrying a
// field that belongs to a *different* kind, with no compile error at all
// -- the strict runtime Zod schema would reject it, but only once it
// actually reaches a parse boundary, not at every call site that produces
// one of these values. Explicitly forbidding every field a kind doesn't
// own (not just `citation`) closes that gap statically, everywhere.

export const CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

export interface VersionedRecord {
  readonly schemaVersion: ContractSchemaVersion;
}

/**
 * Every field that belongs to some EvidenceOutcome kind but not others.
 * Each interface below intersects `Omit<NoExtraEvidenceFields, K>` where
 * K is the set of fields *that kind itself declares* -- Omit drops those
 * keys entirely from this type, leaving only the never-guards for fields
 * that genuinely belong to some other kind. A kind that owns none of
 * these fields (e.g. NotFoundEvidence) intersects the whole thing
 * unomitted.
 */
interface NoExtraEvidenceFields {
  readonly citation?: never;
  readonly conflictingCitation?: never;
  readonly attempt?: never;
  readonly maxAttempts?: never;
  readonly errorCode?: never;
  readonly message?: never;
  readonly retryable?: never;
  readonly reason?: never;
  readonly rejectedCitation?: never;
  readonly quarantineClass?: never;
  readonly operatorActionRequired?: never;
}

/** Where in the employer-authorized source material a quote came from. */
export interface SourceCitation {
  readonly document: string;
  readonly pageOrSection: string;
  readonly offset: number;
  readonly quote: string;
}

/** Kinds that found candidate material bearing on the requirement and must cite it. */
export interface SupportedEvidence extends VersionedRecord, Omit<NoExtraEvidenceFields, "citation"> {
  readonly kind: "supported";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

export interface PartiallySupportedEvidence extends VersionedRecord, Omit<NoExtraEvidenceFields, "citation"> {
  readonly kind: "partially_supported";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

/**
 * Two supplied facts explicitly conflict, so both sides of the conflict
 * need their own citation -- a reviewer inspecting one `contradicted`
 * result must be able to trace and compare both facts, not just the one
 * that happened to be kept.
 */
export interface ContradictedEvidence
  extends VersionedRecord,
    Omit<NoExtraEvidenceFields, "citation" | "conflictingCitation"> {
  readonly kind: "contradicted";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
  readonly conflictingCitation: SourceCitation;
}

/** Something was found but the match is ambiguous; still must cite what was found. */
export interface UnclearEvidence extends VersionedRecord, Omit<NoExtraEvidenceFields, "citation"> {
  readonly kind: "unclear";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

/** Nothing relevant was found; there is no citation to attach. */
export interface NotFoundEvidence extends VersionedRecord, NoExtraEvidenceFields {
  readonly kind: "not_found";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
}

/** Pipeline is still working; no evidence value exists yet. */
export interface ProcessingEvidence extends VersionedRecord, NoExtraEvidenceFields {
  readonly kind: "processing";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
}

/** Pipeline is retrying after a retryable failure. */
export interface RetryingEvidence
  extends VersionedRecord,
    Omit<NoExtraEvidenceFields, "attempt" | "maxAttempts"> {
  readonly kind: "retrying";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** Extraction itself broke before any evidence value could be produced. */
export interface ExtractionErrorEvidence
  extends VersionedRecord,
    Omit<NoExtraEvidenceFields, "errorCode" | "message" | "retryable"> {
  readonly kind: "extraction_error";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * The model proposed a citation that failed exact-source validation
 * (AF-38). rejectedCitation is deliberately `unknown`, not `SourceCitation`:
 * the whole point of this kind is to preserve what was actually rejected,
 * including a structurally malformed proposal (wrong field types, an
 * empty quote where a real one is required) that could never satisfy the
 * strict `SourceCitation` shape in the first place. `unknown` here is the
 * domain-level ceiling; packages/contracts' runtime schema narrows it
 * further to JSON-serializable values only, so a value that would blow
 * up at the actual persist/transport boundary (a bigint, a class
 * instance) is still rejected even though it's structurally "just" a
 * malformed citation.
 */
export interface CitationInvalidEvidence
  extends VersionedRecord,
    Omit<NoExtraEvidenceFields, "reason" | "rejectedCitation"> {
  readonly kind: "citation_invalid";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly reason: string;
  /**
   * Deliberately NOT SourceCitation: the whole point of this kind is to
   * preserve what was actually rejected, including a proposal that could
   * never satisfy the strict shape in the first place (an empty quote,
   * an out-of-range offset). Typing it as SourceCitation meant the
   * validator produced `citation_invalid` outcomes that themselves
   * failed evidenceOutcomeSchema and so could not be persisted or routed
   * to human review -- the exact opposite of what this kind is for.
   */
  readonly rejectedCitation: unknown;
}

/** The source material itself could not be used (corrupt, empty, unreadable). */
export interface InvalidSourceEvidence extends VersionedRecord, Omit<NoExtraEvidenceFields, "reason"> {
  readonly kind: "invalid_source";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly reason: string;
}

/** The source file's format is not one ingestion currently supports. */
export interface UnsupportedFileEvidence extends VersionedRecord, Omit<NoExtraEvidenceFields, "reason"> {
  readonly kind: "unsupported_file";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly reason: string;
}

export type QuarantineClass = "malicious" | "unsupported" | "corrupt" | "persistent_failure";

/** Requires an operator to act; never an implicit path to a hiring outcome. */
export interface QuarantinedEvidence
  extends VersionedRecord,
    Omit<NoExtraEvidenceFields, "quarantineClass" | "reason" | "operatorActionRequired"> {
  readonly kind: "quarantined";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly quarantineClass: QuarantineClass;
  readonly reason: string;
  readonly operatorActionRequired: true;
}

/** Pipeline failed and retries are exhausted or not applicable. */
export interface FailedEvidence
  extends VersionedRecord,
    Omit<NoExtraEvidenceFields, "errorCode" | "message" | "retryable"> {
  readonly kind: "failed";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: false;
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
  readonly jsonSchema: unknown;
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
  /** The model the caller ASKED for, which may be a movable alias. */
  readonly model: string;
  /**
   * The model the provider reports as having actually served the call.
   * Recorded separately because `model` alone is not reproducible: once
   * a movable alias is repointed, records produced by different model
   * revisions become indistinguishable, which defeats the audit and
   * experiment-reproducibility purpose of storing model metadata at all.
   * Absent when the provider does not report it.
   */
  readonly resolvedModel?: string | undefined;
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

  // Validated rather than compared, because every comparison below is false
  // against NaN. A malformed numeric environment value would therefore fall
  // through to `ok` and silently disable the cap entirely: the one outcome a
  // budget check must never produce by accident. `reserveInferenceBudget`
  // already refuses a non-safe-integer cap, so this only brings the in-memory
  // path up to the guarantee the database path already makes.
  if (!Number.isSafeInteger(maxTokensPerPeriod) || maxTokensPerPeriod < 0) {
    throw new Error(
      `checkInferenceBudget requires a non-negative safe integer maxTokensPerPeriod, got: ${maxTokensPerPeriod}`
    );
  }
  if (!Number.isFinite(alertThresholdRatio) || alertThresholdRatio < 0 || alertThresholdRatio > 1) {
    throw new Error(
      `checkInferenceBudget requires an alertThresholdRatio between 0 and 1, got: ${alertThresholdRatio}`
    );
  }
  if (!Number.isFinite(tokensUsedThisPeriod) || tokensUsedThisPeriod < 0) {
    throw new Error(
      `checkInferenceBudget requires a non-negative tokensUsedThisPeriod, got: ${tokensUsedThisPeriod}`
    );
  }

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
  /**
   * True when the sniffed type is ZIP-based but its central directory could
   * not be read, so no uncompressed size is knowable.
   *
   * Review #83, P1: `zipUncompressedBytes` being absent used to mean two
   * different things -- "not an archive" and "an archive we could not
   * inspect" -- and this function read both as the former. A ZIP64 or
   * malformed archive that still sniffed as a valid DOCX therefore skipped
   * the bomb check entirely and validated. The two cases are now
   * distinguishable, because only one of them is safe.
   */
  readonly archiveUninspectable?: boolean | undefined;
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
  // An archive whose central directory cannot be read is quarantined, not
  // validated. The bomb check below is the only thing standing between a
  // 20 MiB DOCX and gigabytes of inflated output, and it cannot run without
  // a declared uncompressed size. Treating "unknown" as "fine" is how a
  // ZIP64 archive bypassed it: it sniffs as a perfectly valid DOCX.
  if (input.archiveUninspectable === true) {
    return {
      outcome: "quarantined",
      reason:
        "File sniffed as a ZIP-based document but its central directory could not be read, so the expansion size is unknown and the archive-bomb check cannot run."
    };
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

/**
 * Normalizes an optional `appliedAt` cell to an ISO instant, or reports that
 * it is not a date at all.
 *
 * Review #83, P2: mapping accepted any non-empty string here and handed it
 * straight to a `timestamptz` column. A cell such as `not-a-date` raised a
 * PostgreSQL cast error *inside the single import transaction*, rolling back
 * every valid row and answering 500. One malformed optional date is supposed
 * to be one failed row, which is the whole point of per-row accounting.
 *
 * Deliberately strict rather than lenient. `new Date("2026-13-45")` and
 * `new Date("garbage")` both yield Invalid Date, but `new Date("2026")` is
 * accepted by the runtime as a year, which would silently turn a stray
 * number in a spreadsheet column into January 1st. So the value must look
 * like a date before it is parsed, and must survive the round trip.
 */
export function normalizeAppliedAt(
  raw: string
): { readonly outcome: "normalized"; readonly value: string } | { readonly outcome: "invalid" } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { outcome: "invalid" };
  }
  // ISO-ish only: YYYY-MM-DD, optionally with a time and zone. A bare year
  // or a locale format like 03/04/2026 is ambiguous between day and month
  // and is refused rather than guessed at.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/u.test(trimmed)) {
    return { outcome: "invalid" };
  }
  const parsed = new Date(trimmed.includes("T") || trimmed.includes(" ") ? trimmed : `${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { outcome: "invalid" };
  }
  // Catches values the pattern admits but the calendar does not, such as
  // 2026-02-30, which Date rolls forward into March rather than refusing.
  //
  // Checked against the literal date parts, NOT against the parsed instant.
  // Review #83: comparing `parsed`'s UTC fields to the literal ones conflates
  // two different things, because a legitimate offset shifts the instant into
  // an adjacent day, month or year. `2026-01-31T23:00:00-05:00` is 1 February
  // in UTC and `2026-01-01T00:00:00+05:30` is 31 December of the previous
  // year, so both were reported as invalid dates back to the operator who
  // supplied them. Any ATS export carrying local offsets lost every candidate
  // dated on the first or last day of a month.
  //
  // Scoping the year and month checks to the date-only branch, as the day
  // check already was, does not fix it: `2026-02-30T00:00:00Z` parses to
  // 2026-03-02 rather than NaN, so that would start silently accepting
  // impossible dates and storing them as the day they rolled into. The
  // calendar question and the offset question have to be asked separately.
  const [year, month, day] = trimmed.slice(0, 10).split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return { outcome: "invalid" };
  }
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() + 1 !== month ||
    calendarDay.getUTCDate() !== day
  ) {
    return { outcome: "invalid" };
  }
  return { outcome: "normalized", value: parsed.toISOString() };
}

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
  // Validated here, before the row reaches the database, so an unparseable
  // optional date fails its own row instead of aborting the transaction that
  // is importing everybody else's.
  const appliedAt = values.appliedAt;
  if (appliedAt !== undefined && normalizeAppliedAt(appliedAt).outcome === "invalid") {
    return {
      outcome: "failed",
      reason: `appliedAt is not a valid date: ${JSON.stringify(appliedAt)}. Use YYYY-MM-DD or a full ISO 8601 timestamp.`
    };
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

// ---- AF-102: durable evidence-extraction processing queue ----

export const EVIDENCE_EXTRACTION_JOB_STATES = ["ready", "running", "completed", "failed"] as const;
export type EvidenceExtractionJobState = (typeof EVIDENCE_EXTRACTION_JOB_STATES)[number];

/** Mutable delivery state. Candidate PII and evidence never belong here. */
export interface EvidenceExtractionJob {
  readonly jobId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly applicationId: string;
  readonly sourceIntakeId: string;
  readonly rubricId: string;
  readonly workflowVersion: string;
  readonly state: EvidenceExtractionJobState;
  readonly enqueuedAt: string;
  readonly availableAt: string;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly failedAt?: string | undefined;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseOwner?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly updatedAt: string;
}

export interface EvidenceExtractionJobTiming {
  readonly queueWaitMs?: number | undefined;
  readonly durationMs?: number | undefined;
}

/** Build the privacy-safe terminal result shared by every worker failure path. */
export function buildEvidenceExtractionFailureOutcomes(
  subject: { readonly organizationId: string; readonly applicationId: string },
  criterionIds: readonly string[],
  failureCode: string
): EvidenceOutcome[] {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(failureCode)) {
    throw new Error("failureCode must be a bounded machine-readable code");
  }
  return criterionIds.map((criterionId) => {
    if (criterionId.trim().length === 0) {
      throw new Error("terminal evidence outcomes require non-empty criterion IDs");
    }
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "failed",
      organizationId: subject.organizationId,
      candidateId: subject.applicationId,
      criterionId,
      errorCode: failureCode,
      message: "Evidence extraction could not be completed.",
      retryable: false
    };
  });
}

function nonNegativeElapsed(later: string, earlier: string): number {
  const elapsed = new Date(later).getTime() - new Date(earlier).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

/** Vendor-neutral timing facts consumed by AF-67. */
export function deriveEvidenceExtractionJobTiming(job: EvidenceExtractionJob): EvidenceExtractionJobTiming {
  const queueWaitMs = job.startedAt === undefined ? undefined : nonNegativeElapsed(job.startedAt, job.enqueuedAt);
  const endedAt = job.completedAt ?? job.failedAt;
  const durationMs = job.startedAt === undefined || endedAt === undefined
    ? undefined
    : nonNegativeElapsed(endedAt, job.startedAt);
  return {
    ...(queueWaitMs === undefined ? {} : { queueWaitMs }),
    ...(durationMs === undefined ? {} : { durationMs })
  };
}

export interface EvidenceExtractionQueueMonitoringSnapshot {
  readonly observedAt: string;
  readonly oldestReadyAgeMs: number | null;
  readonly readyJobs: number;
  readonly runningJobs: number;
  readonly failedJobs: number;
  readonly completedJobs: number;
  readonly totalAttempts: number;
  readonly lastHeartbeatAt: string | null;
  readonly heartbeatAgeMs: number | null;
}

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

export interface EvidenceCardSet {
  readonly applicationId: string;
  readonly cards: readonly EvidenceCard[];
  readonly verifiableCount: number;
  readonly unverifiableCount: number;
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
// The append-only half is the database's (0017_evidence_outcomes.sql rejects UPDATE, DELETE
// and TRUNCATE; 0018_evidence_corrections.sql makes every correction name what it replaced).
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
 * newest timestamp: 0018_evidence_corrections.sql makes the chain a stored fact precisely so this
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
    // history somehow forked despite 0018_evidence_corrections.sql's unique index, take the newest
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
  // reported as a correction at all. 0018_evidence_corrections.sql and 0019_correction_attribution.sql make a partial one
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
    // requirement the correction exists to satisfy. 0017_evidence_outcomes.sql makes deletion
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

export const METRIC_LIMITATION_CODES = [
  /** Nothing has resolved yet; there is no denominator to divide by. */
  "no_sample",
  /** A denominator exists but is too small for the stated threshold. */
  "below_minimum_sample",
  /** Some of the population is excluded from the denominator (e.g. still in flight). */
  "population_incomplete"
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
 * There is deliberately no function here that combines two MetricSamples,
 * and adding one is the way this whole module gets quietly defeated.
 *
 * Pooling only looks like arithmetic. Two samples under different metric
 * names are two different populations, and `metric` is a free-form string,
 * so nothing in the types stops a caller summing a live-pilot sample with
 * an offline-evaluation one and reporting the combined figure. AF-57
 * relies on exactly that separation: it emits
 * `evidence_precision_live_pilot` and
 * `evidence_precision_locked_offline_eval` as distinct names, against two
 * separate targets, so a dashboard cannot pool them by accident.
 *
 * The reason pooling is not merely imprecise but self-serving: the offline
 * set is the one that can be grown cheaply, on demand, without a single
 * recruiter reviewing anything. So a pooled denominator is always easiest
 * to inflate on the side that flatters, and the combined number rises
 * fastest exactly when the live pilot is going worst. That is the failure
 * this module exists to prevent, arriving through the back door as a
 * convenience helper.
 *
 * If a report genuinely needs one headline figure across populations, the
 * honest form is to show both samples with their own sizes and
 * limitations, not to average them. `population_incomplete` already
 * carries the "you are not seeing everything" half.
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

export const CANDIDATE_DECISION_KINDS: readonly CandidateDecisionKind[] = [
  "advance",
  "hold",
  "decline"
] as const;

export type CandidateDecisionKind = "advance" | "hold" | "decline";

export interface CandidateDecision extends VersionedRecord {
  readonly decisionId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly decision: CandidateDecisionKind;
  /** Why. Never optional: an unexplained decision is not reviewable. */
  readonly rationale: string;
  /** Who. Never optional and never a service account -- see 0020_candidate_decisions.sql. */
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
 * the supersedes links rather than by taking the newest timestamp.
 * 0020_candidate_decisions.sql stores that link precisely so this is a
 * lookup and not an inference: two decisions recorded in the same
 * microsecond, or any clock skew, must not be able to invert which one
 * stands.
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
  // Two indexes together make more than one head impossible, and it takes
  // both: 0020_candidate_decisions.sql's partial unique index on
  // supersedes_decision_id stops two decisions claiming the same
  // predecessor, but excludes NULLs by its own predicate, so it says
  // nothing about first decisions. 0021_single_decision_root.sql covers
  // that case with a unique index on (organization_id, application_id)
  // WHERE supersedes_decision_id IS NULL. Before 0021_single_decision_root.sql existed this
  // comment named one index and claimed a guarantee that did not hold:
  // two concurrent first decisions really did produce two heads.
  //
  // If one somehow appears anyway, take the newest so the view is at
  // least deterministic rather than dependent on row order.
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
