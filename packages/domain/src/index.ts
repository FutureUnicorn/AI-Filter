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
  | "access_admin_settings";

export const CAPABILITIES: readonly Capability[] = [
  "approve_rubric",
  "review_candidates",
  "record_decision",
  "view_audit_reports",
  "access_admin_settings"
] as const;

/**
 * Owner and admin currently have identical capabilities: nothing here
 * distinguishes them yet, since no org-lifecycle capability (transfer
 * ownership, delete organization, remove an admin) exists yet. Owner is
 * kept as its own role rather than merged into admin because those
 * future capabilities will belong to owner only.
 */
export const ROLE_CAPABILITIES: Readonly<Record<MembershipRole, readonly Capability[]>> = {
  owner: ["approve_rubric", "review_candidates", "record_decision", "view_audit_reports", "access_admin_settings"],
  admin: ["approve_rubric", "review_candidates", "record_decision", "view_audit_reports", "access_admin_settings"],
  recruiter: ["review_candidates", "record_decision"],
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
