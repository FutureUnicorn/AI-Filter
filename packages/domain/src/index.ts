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
