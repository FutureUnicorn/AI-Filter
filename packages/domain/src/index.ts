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
// not cross-candidate ones within a single tenant. `citation?: never` on every non-citing kind
// closes a real gap the strict Zod schemas alone don't: TypeScript only
// excess-property-checks fresh object literals, so a variable of a wider
// type (or an adapter's typed mapping) could still structurally satisfy
// e.g. NotFoundEvidence while carrying a `citation` no one asked for.
// `never` makes that a compile error everywhere, not just at a parse boundary.

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
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

export interface PartiallySupportedEvidence extends VersionedRecord {
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
export interface ContradictedEvidence extends VersionedRecord {
  readonly kind: "contradicted";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
  readonly conflictingCitation: SourceCitation;
}

/** Something was found but the match is ambiguous; still must cite what was found. */
export interface UnclearEvidence extends VersionedRecord {
  readonly kind: "unclear";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation: SourceCitation;
}

/** Nothing relevant was found; there is no citation to attach. */
export interface NotFoundEvidence extends VersionedRecord {
  readonly kind: "not_found";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation?: never;
}

/** Pipeline is still working; no evidence value exists yet. */
export interface ProcessingEvidence extends VersionedRecord {
  readonly kind: "processing";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly citation?: never;
}

/** Pipeline is retrying after a retryable failure. */
export interface RetryingEvidence extends VersionedRecord {
  readonly kind: "retrying";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly citation?: never;
}

/** Extraction itself broke before any evidence value could be produced. */
export interface ExtractionErrorEvidence extends VersionedRecord {
  readonly kind: "extraction_error";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly citation?: never;
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
export interface CitationInvalidEvidence extends VersionedRecord {
  readonly kind: "citation_invalid";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly reason: string;
  readonly rejectedCitation: unknown;
  readonly citation?: never;
}

/** The source material itself could not be used (corrupt, empty, unreadable). */
export interface InvalidSourceEvidence extends VersionedRecord {
  readonly kind: "invalid_source";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly reason: string;
  readonly citation?: never;
}

/** The source file's format is not one ingestion currently supports. */
export interface UnsupportedFileEvidence extends VersionedRecord {
  readonly kind: "unsupported_file";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly reason: string;
  readonly citation?: never;
}

export type QuarantineClass = "malicious" | "unsupported" | "corrupt" | "persistent_failure";

/** Requires an operator to act; never an implicit path to a hiring outcome. */
export interface QuarantinedEvidence extends VersionedRecord {
  readonly kind: "quarantined";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly quarantineClass: QuarantineClass;
  readonly reason: string;
  readonly operatorActionRequired: true;
  readonly citation?: never;
}

/** Pipeline failed and retries are exhausted or not applicable. */
export interface FailedEvidence extends VersionedRecord {
  readonly kind: "failed";
  readonly organizationId: string;
  readonly candidateId: string;
  readonly criterionId: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: false;
  readonly citation?: never;
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
