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
