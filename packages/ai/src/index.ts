import OpenAI from "openai";
import { z } from "zod";

import type { BoundaryContract } from "@signal-audit/contracts";
import { CONTRACT_SCHEMA_VERSION, assertUnreachableEvidenceOutcome } from "@signal-audit/domain";
import type {
  AiAdapter,
  AiCallMetadata,
  AiStructuredCallInput,
  AiStructuredCallResult,
  ContradictedEvidence,
  DomainPort,
  EvidenceOutcome,
  PartiallySupportedEvidence,
  SourceCitation,
  SupportedEvidence,
  UnclearEvidence
} from "@signal-audit/domain";

/** AI provider adapters will map provider data into domain-owned abstractions. */
export interface AiAdapterBoundary {
  readonly contract: BoundaryContract;
  readonly domain: DomainPort;
}

// ---- AF-34: provider-neutral AI adapter (OpenAI Responses API) ----
//
// createOpenAiAdapter implements the domain-owned AiAdapter port
// (packages/domain), so nothing outside this file names OpenAI or the
// Responses API shape. The optional `client` parameter is the only
// reason this is testable without a real API key or network call: it
// accepts anything shaped like the one method actually used
// (`responses.create`), not the full OpenAI SDK class, so a test can
// pass a plain object instead of mocking the SDK.

/** The one OpenAI SDK surface this adapter actually calls. */
export interface OpenAiResponsesClient {
  responses: {
    create(params: {
      model: string;
      input: Array<{ role: "system" | "user"; content: string }>;
      text: {
        format: {
          type: "json_schema";
          name: string;
          schema: Record<string, unknown>;
          strict: true;
        };
      };
      /** Provider-side retention. Always sent explicitly; see the call site. */
      store: boolean;
    }): Promise<{
      output_text: string;
      /** The model that actually served the request, which can differ
       * from the requested one when that is a movable alias. */
      model?: string | undefined;
      /** Absent when the provider reported no usage. Never defaulted to
       * zero: an unmetered billable call must not look free. */
      usage?: { input_tokens: number; output_tokens: number } | undefined;
    }>;
  };
}

/**
 * Explicit "this call site genuinely has no kill switch" marker, for
 * tests and for adapters constructed outside the inference path. Named
 * so that grepping for it finds every place the control is bypassed --
 * which an optional field silently hid.
 */
export const alwaysDisengagedKillSwitch = async (): Promise<{ readonly engaged: boolean }> => ({
  engaged: false
});

export interface OpenAiAdapterConfig {
  readonly apiKey: string;
  readonly model: string;
  /**
   * Checked before every call; when it resolves `engaged: true`, the
   * provider is never invoked.
   *
   * REQUIRED, not optional. While it was optional, every construction
   * using the original `{ apiKey, model }` shape still compiled and
   * called the provider without consulting the database, so engaging
   * the switch could not reliably halt inference -- which is the entire
   * point of the control. Making it mandatory means an adapter that
   * skips the check cannot be built at all: it is a compile error.
   *
   * The caller injects it (e.g. `() => getInferenceKillSwitchStatus(
   * databaseUrl, schema)` from packages/db, whose row shape already
   * matches). Injection rather than a direct import keeps packages/ai
   * free of a dependency on packages/db, which the architecture rules
   * forbid. Tests that genuinely do not exercise the switch pass
   * `alwaysDisengagedKillSwitch` so the omission is explicit and
   * greppable rather than silent.
   */
  readonly checkKillSwitch: () => Promise<{ readonly engaged: boolean; readonly reason?: string }>;
}

/**
 * Thrown instead of ever calling the provider when the kill switch is
 * engaged. This adapter is generic (no concept of a criterionId or
 * retry count), so it can only refuse the call and say why -- mapping
 * that into an EvidenceOutcome (killSwitchRetryOutcome, below) is the
 * caller's job, at whatever per-criterion layer actually knows those.
 */
export class InferenceKillSwitchEngagedError extends Error {
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    super(reason === undefined ? "Inference kill switch is engaged" : `Inference kill switch is engaged: ${reason}`);
    this.name = "InferenceKillSwitchEngagedError";
    this.reason = reason;
  }
}

/**
 * The real OpenAI SDK's `responses.create` is overloaded (streaming vs.
 * non-streaming vs. base), so its class type is not directly assignable
 * to the narrow `OpenAiResponsesClient` interface above -- TypeScript
 * checks overloaded methods contravariantly even with method-shorthand
 * syntax. Wrapping it in a concrete call sidesteps that: overload
 * resolution happens against the actual argument shape at this call
 * site, not against a structural interface comparison.
 */
function wrapRealOpenAiClient(openai: OpenAI): OpenAiResponsesClient {
  return {
    responses: {
      async create(params) {
        const response = await openai.responses.create({
          model: params.model,
          input: params.input,
          text: params.text,
          store: params.store
        });
        // response.model is the model that actually served the call.
        // Discarding it made records produced by different revisions of
        // a movable alias indistinguishable after the alias moved.
        //
        // Usage is passed through as-is, including absent. Defaulting it
        // to 0/0 turned an unknown but potentially billable call into a
        // legitimate free one: repeated responses in that state would
        // never advance the ledger and could bypass the cap entirely.
        // The adapter fails closed on it instead.
        return {
          output_text: response.output_text,
          model: response.model,
          ...(response.usage === undefined || response.usage === null
            ? {}
            : {
                usage: {
                  input_tokens: response.usage.input_tokens,
                  output_tokens: response.usage.output_tokens
                }
              })
        };
      }
    }
  };
}

/**
 * The provider returned no usage data. Thrown rather than defaulted to
 * zero so an unmetered call can never be mistaken for a free one; the
 * caller decides whether to retry or halt, but it cannot silently
 * under-count against the budget.
 */
export class AiUsageUnavailableError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(`Provider returned no usage for model ${model}; refusing to record it as a zero-token call.`);
    this.name = "AiUsageUnavailableError";
    this.model = model;
  }
}

/**
 * The call succeeded and was billed, but `output_text` was not valid
 * JSON (a refusal, a truncated response, an empty body). Carries the
 * call's metadata -- including real token usage -- so the caller can
 * still record what the attempt cost before deciding whether to retry.
 */
export class AiStructuredCallParseError extends Error {
  readonly metadata: AiCallMetadata;

  constructor(metadata: AiCallMetadata, cause: unknown) {
    super(`Structured output for schema ${metadata.schemaName} was not valid JSON.`, { cause });
    this.name = "AiStructuredCallParseError";
    this.metadata = metadata;
  }
}

export function createOpenAiAdapter(
  config: OpenAiAdapterConfig,
  client?: OpenAiResponsesClient
): AiAdapter {
  const openai: OpenAiResponsesClient = client ?? wrapRealOpenAiClient(new OpenAI({ apiKey: config.apiKey }));

  return {
    async runStructuredCall(input: AiStructuredCallInput): Promise<AiStructuredCallResult> {
      const status = await config.checkKillSwitch();
      if (status.engaged) {
        throw new InferenceKillSwitchEngagedError(status.reason);
      }

      const response = await openai.responses.create({
        model: config.model,
        input: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt }
        ],
        text: {
          format: {
            type: "json_schema",
            name: input.schemaName,
            schema: input.jsonSchema,
            strict: true
          }
        },
        // The structured output carries verbatim quotes from candidate
        // documents. The Responses API retains response objects by
        // default, so omitting this silently created a provider-side
        // copy of candidate material on every successful call. Opt out
        // explicitly; retention must be a deliberate decision, not the
        // consequence of leaving a parameter off.
        store: false
      });

      // Fail closed on unknown usage. The provider has already been
      // called and may already have billed for it, so the one thing this
      // must not do is report it as a zero-token call: that would let a
      // provider degradation return usage-less responses indefinitely
      // while the ledger never advances and the cap never trips.
      if (response.usage === undefined || response.usage === null) {
        throw new AiUsageUnavailableError(config.model);
      }

      // Metadata is built BEFORE parsing, deliberately. A refused,
      // truncated, empty or otherwise non-JSON `output_text` still
      // represents a call that was made and billed; building metadata
      // afterwards meant JSON.parse threw first and the caller was left
      // with no token counts to hand to recordInferenceUsage, so retries
      // of failing responses stayed invisible to the budget and could
      // accumulate unbounded cost.
      const metadata: AiCallMetadata = {
        provider: "openai",
        model: config.model,
        ...(response.model === undefined ? {} : { resolvedModel: response.model }),
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        schemaName: input.schemaName,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        }
      };

      let output: unknown;
      try {
        output = JSON.parse(response.output_text);
      } catch (cause) {
        throw new AiStructuredCallParseError(metadata, cause);
      }
      return { output, metadata };
    }
  };
}

// ---- AF-35: factual extraction structured-output schema ----
//
// The states a model is actually asked to choose between when
// extracting evidence for one criterion against one document. This is
// a deliberate subset of packages/domain's EvidenceOutcome kinds
// (AF-13): only the ones a model can genuinely decide from the text.
// citation_invalid is assigned by the system after AF-38 checks the
// quote against the source, and extraction_error/quarantined/
// processing/retrying/invalid_source/unsupported_file/failed are
// pipeline states that have nothing to do with what the model itself
// returned. Excluding them from the model-facing schema is the point:
// a model cannot self-report "the citation validator will reject me."

export const EVIDENCE_EXTRACTION_SCHEMA_NAME = "evidence_response";
export const EVIDENCE_EXTRACTION_SCHEMA_VERSION = "1.0.0";

export const EVIDENCE_EXTRACTION_STATES = [
  "supported",
  "partially_supported",
  "contradicted",
  "not_found",
  "unclear"
] as const;

export type EvidenceExtractionState = (typeof EVIDENCE_EXTRACTION_STATES)[number];

/**
 * Strict JSON Schema for OpenAI's `text.format` structured-output
 * parameter (AF-34's adapter passes this straight through as
 * `jsonSchema`). `additionalProperties: false` and every property
 * listed in `required` everywhere, including nested objects, because
 * OpenAI's strict mode requires both.
 */
export const EVIDENCE_EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion_id", "state", "quote", "source"],
        properties: {
          criterion_id: { type: "string" },
          state: { type: "string", enum: EVIDENCE_EXTRACTION_STATES },
          quote: {
            type: "string",
            description:
              "Exact verbatim substring copied from the source document. Empty string only when state is not_found."
          },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["document", "page_or_section", "offset"],
            properties: {
              document: { type: "string" },
              page_or_section: { type: "string" },
              offset: { type: "integer" }
            }
          }
        }
      }
    }
  }
};

/**
 * Runtime validator for the model's raw (not-yet-trusted) output. This
 * is intentionally separate from packages/contracts' versioned
 * EvidenceOutcome schemas (AF-13): it validates an intermediate,
 * model-facing shape, not the system's own persisted contract. AF-36
 * owns mapping a validated item here into a real EvidenceOutcome.
 */
export const evidenceExtractionItemSchema = z
  .strictObject({
    criterion_id: z.string().min(1),
    state: z.enum(EVIDENCE_EXTRACTION_STATES),
    quote: z.string(),
    source: z.strictObject({
      document: z.string().min(1),
      page_or_section: z.string(),
      offset: z.number().int()
    })
  })
  .refine((item) => (item.state === "not_found" ? item.quote === "" : item.quote.trim().length > 0), {
    message: "quote must be empty only when state is not_found, and citing quotes must contain non-whitespace",
    path: ["quote"]
  })
  .refine((item) => item.state === "not_found" || item.source.page_or_section.trim().length > 0, {
    message: "citing states require a nonempty page_or_section",
    path: ["source", "page_or_section"]
  })
  .refine((item) => item.state === "not_found" || item.source.offset >= 0, {
    message: "citing states require a nonnegative offset",
    path: ["source", "offset"]
  });

export const evidenceExtractionResponseSchema = z.strictObject({
  items: z.array(evidenceExtractionItemSchema)
});

export type EvidenceExtractionItem = z.infer<typeof evidenceExtractionItemSchema>;

// ---- AF-36: rubric-to-evidence mapping ----
//
// Reconciles the model's raw (AF-35-validated) items against the
// rubric that was actually asked about, guaranteeing exactly one
// EvidenceOutcome per rubric criterion -- never more, never fewer,
// regardless of what the model returned. A criterion the model omitted
// is not the same thing as a criterion the model confidently found
// nothing for: not_found is a deliberate answer the model chose;
// omission is a pipeline gap. Both omission and duplication become
// extraction_error with a distinct errorCode, never a silently
// invented not_found and never a silently dropped criterion. A
// criterion_id in the model's output that isn't in the rubric at all
// is dropped -- it cannot correspond to an employer-defined
// requirement (docs/PRODUCT_BOUNDARY.md: "AI MUST NOT invent
// requirements"), so there is nothing in the rubric for it to become.

function citationFrom(item: EvidenceExtractionItem): SourceCitation {
  return {
    document: item.source.document,
    pageOrSection: item.source.page_or_section,
    offset: item.source.offset,
    quote: item.quote
  };
}

function citingCitationIsPersistable(item: EvidenceExtractionItem): boolean {
  return (
    item.source.page_or_section.trim().length > 0 &&
    item.source.offset >= 0 &&
    item.quote.trim().length > 0
  );
}

function invalidCitationOutcome(criterionId: string): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    criterionId,
    errorCode: "invalid_citation",
    message: "The model's citing item is missing a persistable source citation.",
    retryable: true
  };
}

function mapExtractedItem(item: EvidenceExtractionItem): EvidenceOutcome {
  const criterionId = item.criterion_id;
  switch (item.state) {
    case "not_found":
      return { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId };
    case "supported":
    case "partially_supported":
    case "contradicted":
    case "unclear":
      if (!citingCitationIsPersistable(item)) {
        return invalidCitationOutcome(criterionId);
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        kind: item.state,
        criterionId,
        citation: citationFrom(item)
      };
  }
}

function omittedCriterionOutcome(criterionId: string): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    criterionId,
    errorCode: "model_omitted_criterion",
    message: "The model's response did not include this criterion.",
    retryable: true
  };
}

function duplicateCriterionOutcome(criterionId: string, count: number): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    criterionId,
    errorCode: "duplicate_criterion_response",
    message: `The model returned ${count} responses for one criterion.`,
    retryable: true
  };
}

export function mapRubricToEvidence(
  rubricCriterionIds: readonly string[],
  extractedItems: readonly EvidenceExtractionItem[]
): EvidenceOutcome[] {
  // The rubric IDs arrive as an unconstrained string[] with no upstream
  // schema or branded type guaranteeing anything about them, so they are
  // validated here rather than assumed. Both checks protect the promise
  // this function makes about its OUTPUT:
  //
  // - An empty ID would produce an outcome whose criterionId is "",
  //   which fails evidenceOutcomeSchema (criterionId requires at least
  //   one character). Returning it would mean handing back a value
  //   advertised as a persistable EvidenceOutcome that cannot actually
  //   be persisted.
  // - A repeated ID would emit several outcomes for the same criterion,
  //   contradicting the one-outcome-per-criterion invariant and letting
  //   a downstream consumer persist or count it twice.
  //
  // Rejecting rather than silently de-duplicating: a rubric containing
  // the same criterion twice is a malformed rubric, and quietly
  // collapsing it would hide that from whoever authored it.
  const seen = new Set<string>();
  for (const criterionId of rubricCriterionIds) {
    if (criterionId.length === 0) {
      throw new Error("mapRubricToEvidence requires non-empty rubric criterion IDs");
    }
    if (seen.has(criterionId)) {
      throw new Error(`mapRubricToEvidence requires unique rubric criterion IDs; "${criterionId}" appears more than once`);
    }
    seen.add(criterionId);
  }

  const itemsByCriterion = new Map<string, EvidenceExtractionItem[]>();
  for (const item of extractedItems) {
    const existing = itemsByCriterion.get(item.criterion_id);
    if (existing === undefined) {
      itemsByCriterion.set(item.criterion_id, [item]);
    } else {
      existing.push(item);
    }
  }

  return rubricCriterionIds.map((criterionId): EvidenceOutcome => {
    const matches = itemsByCriterion.get(criterionId) ?? [];
    const [firstMatch, ...rest] = matches;
    if (firstMatch === undefined) {
      return omittedCriterionOutcome(criterionId);
    }
    if (rest.length > 0) {
      return duplicateCriterionOutcome(criterionId, matches.length);
    }
    return mapExtractedItem(firstMatch);
  });
}

// ---- AF-37: deterministic model routing ----
//
// Which model handles a retry is decided entirely from four observable,
// code-computed flags -- never by the model itself (no model-selected
// routing, no tool use). All four flags come from a prior attempt: this
// is a retry-escalation decision, not something known before the first
// call ever runs.

export type EscalationReason =
  | "unreadable_input"
  | "citation_failed"
  | "contradiction_detected"
  | "injection_indicator";

export interface RoutingSignals {
  readonly unreadableInput: boolean;
  readonly citationFailed: boolean;
  readonly contradictionDetected: boolean;
  readonly injectionIndicatorDetected: boolean;
}

export interface ModelRoutingConfig {
  readonly defaultModel: string;
  readonly escalationModel: string;
}

export interface ModelRoutingResult {
  readonly model: string;
  readonly tier: "default" | "escalated";
  readonly reasons: readonly EscalationReason[];
}

export function routeModel(config: ModelRoutingConfig, signals: RoutingSignals): ModelRoutingResult {
  const reasons: EscalationReason[] = [];
  if (signals.unreadableInput) {
    reasons.push("unreadable_input");
  }
  if (signals.citationFailed) {
    reasons.push("citation_failed");
  }
  if (signals.contradictionDetected) {
    reasons.push("contradiction_detected");
  }
  if (signals.injectionIndicatorDetected) {
    reasons.push("injection_indicator");
  }

  return reasons.length === 0
    ? { model: config.defaultModel, tier: "default", reasons: [] }
    : { model: config.escalationModel, tier: "escalated", reasons };
}

// ---- AF-38: exact-source citation validator ----
//
// Port and harden scripts/validate_citations.py -- the single
// highest-leverage integrity check in the system. Ported: the same
// core rule (a citing item's quote must exist verbatim in the source
// text, and at the claimed offset if a valid one is given). Hardened
// two ways: (1) most of the Python version's "does this state even
// need a quote" branch is now structurally unreachable, not just
// checked -- AF-13's EvidenceOutcome only lets a citing kind carry a
// citation field at all, so not_found/processing/etc. cannot fail this
// check by construction, they simply pass through unexamined; (2)
// coverage extends to "unclear", which the ticket's own prose names
// only three of, but which the Python POC's validator (and AF-13's own
// domain model) already treats as a citing state requiring proof --
// leaving it unvalidated would be a silent regression, not a narrower
// scope.

function isCitingEvidence(
  outcome: EvidenceOutcome
): outcome is SupportedEvidence | PartiallySupportedEvidence | ContradictedEvidence | UnclearEvidence {
  return (
    outcome.kind === "supported" ||
    outcome.kind === "partially_supported" ||
    outcome.kind === "contradicted" ||
    outcome.kind === "unclear"
  );
}

function toCitationInvalid(criterionId: string, rejectedCitation: SourceCitation, reason: string): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    criterionId,
    reason,
    rejectedCitation
  };
}

/**
 * Non-citing outcomes pass through unexamined -- there is nothing to
 * validate and no citation field to inspect. A citing outcome whose
 * quote fails this check is discarded and replaced with
 * `citation_invalid`, carrying the rejected citation and why, ready for
 * AF-39 to route to human review.
 */
export function validateCitation(outcome: EvidenceOutcome, sourceText: string): EvidenceOutcome {
  if (!isCitingEvidence(outcome)) {
    return outcome;
  }

  const { citation, criterionId } = outcome;

  if (citation.quote.length === 0) {
    return toCitationInvalid(criterionId, citation, "missing quote for a citing state");
  }
  if (!sourceText.includes(citation.quote)) {
    return toCitationInvalid(
      criterionId,
      citation,
      "quote not found verbatim in source text (likely hallucination)"
    );
  }
  // Offsets are compared in Unicode CODE POINTS, matching the Python
  // validator this ports (scripts/validate_citations.py indexes Python
  // strings, which are code-point indexed). JavaScript's slice indexes
  // UTF-16 code units, so any astral character before the quote -- an
  // emoji, many CJK extension characters -- shifts every later offset
  // and the two implementations disagree. In "😀Built" the correct
  // offset of "Built" is 1 in Python but 2 in UTF-16 units, so slicing
  // by the Python offset started inside the surrogate pair and reported
  // a valid citation as invalid.
  const sourceCodePoints = [...sourceText];

  // An offset at or past the end of the source is not "unverifiable", it
  // is impossible. Previously the range guard skipped the check
  // entirely for such values, so a claimed offset of 9999 passed
  // validation unexamined as long as the quote appeared somewhere in the
  // text -- preserving an impossible citation location as valid evidence.
  if (citation.offset >= sourceCodePoints.length) {
    return toCitationInvalid(
      criterionId,
      citation,
      "claimed offset is past the end of the source text"
    );
  }

  if (citation.offset >= 0) {
    const window = sourceCodePoints
      .slice(citation.offset, citation.offset + [...citation.quote].length)
      .join("");
    if (window !== citation.quote) {
      return toCitationInvalid(criterionId, citation, "quote exists in source but not at the claimed offset");
    }
  }

  return outcome;
}

// ---- AF-39: route ambiguous/invalid/suspicious evidence to human review ----
//
// A closed, exhaustive switch, not an allow/deny list: the default
// branch calls assertUnreachableEvidenceOutcome, so a future
// EvidenceOutcome kind forces a real decision here (a compile error)
// instead of silently defaulting to "no review needed" -- fail closed,
// never silently resolved.
//
// The ticket names four categories. Failed citation checks and
// contradictions are EvidenceOutcome kinds (citation_invalid,
// contradicted) and route from the switch. The other two are not
// outcomes at all until this layer says so:
//
// * Failed schema validation never produces an EvidenceExtractionItem
//   (evidenceExtractionResponseSchema rejects the payload first, and
//   mapRubricToEvidence only sees already-valid items). Callers pass
//   the parse failure itself into routeForReview, or convert it into
//   per-criterion extraction_error records via
//   outcomesForSchemaValidationFailure so the failure is persistable.
// * Injection indicators are a routing signal (AF-37), not a
//   quarantined outcome. A later supported/not_found result does not
//   clear the signal -- pass injectionIndicatorDetected on the
//   context so the original detection still fail-closes to review.
//
// invalid_source/unsupported_file/failed are included too: they are
// broken or incomplete evidence a human needs to know about.
// supported/partially_supported/not_found are confident, validated
// results -- they still go through the ordinary review flow (AF-5),
// just without this special flag, unless an injection signal is
// attached. processing/retrying have not resolved into anything yet.

export type ReviewRouting =
  | { readonly needsReview: false }
  | { readonly needsReview: true; readonly reason: string };

export interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationFailure {
  readonly type: "schema_validation_failure";
  readonly issues: readonly SchemaValidationIssue[];
}

export type ReviewRoutingInput = EvidenceOutcome | SchemaValidationFailure;

export interface ReviewRoutingContext {
  readonly injectionIndicatorDetected?: boolean;
}

export type ExtractionParseResult =
  | { readonly ok: true; readonly items: readonly EvidenceExtractionItem[] }
  | { readonly ok: false; readonly failure: SchemaValidationFailure };

function schemaValidationFailureFromZod(error: z.ZodError): SchemaValidationFailure {
  return {
    type: "schema_validation_failure",
    issues: error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "" : issue.path.map(String).join("."),
      message: issue.message
    }))
  };
}

function summarizeSchemaValidationFailure(failure: SchemaValidationFailure): string {
  if (failure.issues.length === 0) {
    return "unknown schema error";
  }
  return failure.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path}: ${issue.message}`))
    .join("; ");
}

export function isSchemaValidationFailure(input: ReviewRoutingInput): input is SchemaValidationFailure {
  return "type" in input && input.type === "schema_validation_failure";
}

/** Accept the raw model payload and keep schema rejection as a first-class failure. */
export function parseEvidenceExtractionResponse(value: unknown): ExtractionParseResult {
  const parsed = evidenceExtractionResponseSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, items: parsed.data.items };
  }
  return { ok: false, failure: schemaValidationFailureFromZod(parsed.error) };
}

/**
 * One persistable extraction_error per rubric criterion when the whole
 * model response failed schema validation -- the same "exactly one
 * outcome per criterion" rule as mapRubricToEvidence, so a rejected
 * payload cannot disappear before human review.
 */
export function outcomesForSchemaValidationFailure(
  rubricCriterionIds: readonly string[],
  failure: SchemaValidationFailure
): EvidenceOutcome[] {
  const summary = summarizeSchemaValidationFailure(failure);
  return rubricCriterionIds.map((criterionId) => ({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    criterionId,
    errorCode: "schema_validation_failed",
    message: `Model response failed schema validation: ${summary}`,
    retryable: true
  }));
}

function routeOutcomeForReview(outcome: EvidenceOutcome): ReviewRouting {
  switch (outcome.kind) {
    case "supported":
    case "partially_supported":
    case "not_found":
    case "processing":
    case "retrying":
      return { needsReview: false };
    case "unclear":
      return { needsReview: true, reason: "Evidence is ambiguous and requires human judgment." };
    case "contradicted":
      return { needsReview: true, reason: "Supplied facts conflict about this criterion." };
    case "citation_invalid":
      return { needsReview: true, reason: `Citation failed validation: ${outcome.reason}` };
    case "extraction_error":
      return { needsReview: true, reason: `Extraction failed: ${outcome.message}` };
    case "invalid_source":
      return { needsReview: true, reason: `Source material could not be used: ${outcome.reason}` };
    case "unsupported_file":
      return { needsReview: true, reason: `Unsupported file format: ${outcome.reason}` };
    case "quarantined":
      return { needsReview: true, reason: `Quarantined (${outcome.quarantineClass}): ${outcome.reason}` };
    case "failed":
      return { needsReview: true, reason: `Processing failed: ${outcome.message}` };
    default:
      return assertUnreachableEvidenceOutcome(outcome);
  }
}

function withInjectionSignal(routing: ReviewRouting): ReviewRouting {
  if (routing.needsReview) {
    return {
      needsReview: true,
      reason: `${routing.reason} Injection indicator was also detected.`
    };
  }
  return {
    needsReview: true,
    reason: "Injection indicator detected; this result cannot be trusted without human review."
  };
}

export function routeForReview(
  input: ReviewRoutingInput,
  context: ReviewRoutingContext = {}
): ReviewRouting {
  if (isSchemaValidationFailure(input)) {
    const routing: ReviewRouting = {
      needsReview: true,
      reason: `Model response failed schema validation: ${summarizeSchemaValidationFailure(input)}`
    };
    return context.injectionIndicatorDetected === true ? withInjectionSignal(routing) : routing;
  }

  const routing = routeOutcomeForReview(input);
  return context.injectionIndicatorDetected === true ? withInjectionSignal(routing) : routing;
}

// ---- AF-42: inference kill switch ----
//
// The one place a kill-switch block turns into an EvidenceOutcome:
// "retrying", never "failed" or "extraction_error". A halted call is
// not a broken one -- the pipeline should pick this criterion back up
// once an operator disengages the switch, not discard it or hand it to
// AF-39's review queue as if something went wrong with the extraction
// itself.

export function killSwitchRetryOutcome(criterionId: string, attempt: number, maxAttempts: number): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "retrying",
    criterionId,
    attempt,
    maxAttempts
  };
}
