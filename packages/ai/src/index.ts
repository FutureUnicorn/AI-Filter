import OpenAI from "openai";
import { z } from "zod";

import { sourceCitationSchema } from "@signal-audit/contracts";
import type { BoundaryContract } from "@signal-audit/contracts";
import { CONTRACT_SCHEMA_VERSION } from "@signal-audit/domain";
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
          schema: unknown;
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
    }>;
  };
}

export interface OpenAiAdapterConfig {
  readonly apiKey: string;
  readonly model: string;
}

function isOpenAiJsonSchema(schema: unknown): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
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
          text: {
            format: {
              ...params.text.format,
              schema: params.text.format.schema as Record<string, unknown>
            }
          },
          store: params.store
        });
        // response.model is the model that actually served the call.
        // Discarding it made records produced by different revisions of
        // a movable alias indistinguishable after the alias moved.
        return { output_text: response.output_text, model: response.model };
      }
    }
  };
}

/**
 * The call reached the provider and completed, but `output_text` was not
 * valid JSON (a structured-output refusal, a truncated response, an
 * empty body). Carries the call's metadata so the caller can still
 * record that the call happened -- and, once AF-41 adds token counts,
 * what it cost -- rather than losing every trace of it to a throw.
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
      if (!isOpenAiJsonSchema(input.jsonSchema)) {
        throw new TypeError("OpenAI structured output requires an object JSON Schema.");
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

      // Built BEFORE parsing. A refusal, truncation or empty body is
      // still a call that happened and was billed; constructing metadata
      // afterwards meant JSON.parse threw first and the caller received
      // no provider/model/prompt/schema information at all, defeating
      // the requirement to record metadata on every call and leaving
      // AF-40 unable to audit failed ones.
      const metadata: AiCallMetadata = {
        provider: "openai",
        model: config.model,
        ...(response.model === undefined ? {} : { resolvedModel: response.model }),
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        schemaName: input.schemaName
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
// Bumped to 2.0.0 by the same change that made `conflicting` required.
//
// Adding a required property is breaking in both directions: a response
// that was valid under 1.0.0 (no `conflicting` key) is now rejected, and a
// 2.0.0 response carries a key a 1.0.0 consumer does not expect. AF-40
// persists this string on every extraction run, so leaving it at 1.0.0
// would label two incompatible response shapes with the same version and
// leave a consumer replaying that history unable to pick the right
// validator -- the audit record would say the runs were comparable when
// they are not.
//
// Major rather than minor because the break is to previously-valid input,
// not an additive option.
export const EVIDENCE_EXTRACTION_SCHEMA_VERSION = "2.0.0";

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
        required: ["criterion_id", "state", "quote", "source", "conflicting"],
        properties: {
          criterion_id: { type: "string", minLength: 1 },
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
              // minLength here for the same reason as criterion_id: the
              // Zod validator requires this unconditionally, so leaving
              // the model-facing schema silent asks the provider for
              // something it will then be rejected for producing.
              document: { type: "string", minLength: 1 },
              page_or_section: { type: "string" },
              offset: { type: "integer" }
            }
          },
          // A contradiction has two sides. AF-13's ContradictedEvidence
          // requires BOTH `citation` and `conflictingCitation`, so an item
          // carrying one quote could never map to a persistable
          // contradicted outcome -- it is the only state in the union that
          // needs a second citation, and without this the kind is
          // unreachable no matter what the model returns.
          //
          // Expressed as a null union rather than an omitted key because
          // this schema is sent with `strict: true`, where optionality is
          // spelled `type: [..., "null"]` rather than by leaving the
          // property out of `required`. Non-null exactly when state is
          // "contradicted"; the Zod validator enforces that both ways.
          conflicting: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["quote", "source"],
            description:
              "The opposing evidence, when state is contradicted. Must be null for every other state.",
            properties: {
              quote: {
                type: "string",
                description: "Exact verbatim substring that conflicts with the primary quote."
              },
              source: {
                type: "object",
                additionalProperties: false,
                required: ["document", "page_or_section", "offset"],
                properties: {
                  document: { type: "string", minLength: 1 },
                  page_or_section: { type: "string" },
                  offset: { type: "integer" }
                }
              }
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
    }),
    // Nullish rather than required-nullable: the model-facing JSON schema
    // above always asks for the key (strict mode), but this validator is
    // also the entry point for callers constructing items directly, and
    // requiring the key there would break every non-contradicted fixture
    // for no safety gain. The refinements below carry the real rule.
    conflicting: z
      .strictObject({
        quote: z.string(),
        source: z.strictObject({
          document: z.string().min(1),
          page_or_section: z.string(),
          offset: z.number().int()
        })
      })
      .nullish()
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
  })
  // A contradiction needs both sides or it cannot be persisted at all:
  // AF-13's ContradictedEvidence requires citation AND conflictingCitation.
  .refine((item) => item.state !== "contradicted" || (item.conflicting ?? null) !== null, {
    message: "state contradicted requires a conflicting quote and source; a contradiction has two sides",
    path: ["conflicting"]
  })
  // ...and only a contradiction may carry one. Without this, a supported
  // item could smuggle a second citation that nothing downstream reads,
  // which is a quiet way to lose evidence a reviewer was meant to see.
  .refine((item) => item.state === "contradicted" || (item.conflicting ?? null) === null, {
    message: "only state contradicted may carry a conflicting quote",
    path: ["conflicting"]
  })
  .refine(
    (item) =>
      item.state !== "contradicted" ||
      (item.conflicting != null &&
        item.conflicting.quote.trim().length > 0 &&
        item.conflicting.source.page_or_section.trim().length > 0 &&
        item.conflicting.source.offset >= 0),
    {
      // The same coordinate rules the primary citation already gets. A
      // conflicting side that fails sourceCitationSchema would make the
      // contradicted outcome unpersistable for a second, subtler reason.
      message:
        "a conflicting side requires a nonempty quote, a nonempty page_or_section and a nonnegative offset",
      path: ["conflicting"]
    }
  );

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

function conflictingCitationFrom(item: EvidenceExtractionItem): SourceCitation | undefined {
  const side = item.conflicting;
  if (side == null) {
    return undefined;
  }
  return {
    document: side.source.document,
    pageOrSection: side.source.page_or_section,
    offset: side.source.offset,
    quote: side.quote
  };
}

// Both helpers answer one question -- "will the citation this builds
// survive sourceCitationSchema?" -- so they ask the schema instead of
// restating it. The restated version omitted two of its four rules: a
// nonempty `document`, and an `offset` that is an INTEGER rather than
// merely non-negative. So `document: ""`, `offset: 0.5` and
// `offset: Infinity` all passed here and produced a citing outcome that
// then failed the persisted contract downstream, which is the failure the
// predicate exists to prevent.
//
// Parsing cannot drift from the schema. A restatement always can, and did.

function citingCitationIsPersistable(item: EvidenceExtractionItem): boolean {
  return sourceCitationSchema.safeParse(citationFrom(item)).success;
}

function conflictingCitationIsPersistable(item: EvidenceExtractionItem): boolean {
  const side = conflictingCitationFrom(item);
  return side !== undefined && sourceCitationSchema.safeParse(side).success;
}

/**
 * Who the outcomes are about.
 *
 * AF-13's review added organizationId and candidateId to every
 * EvidenceOutcome kind, because outcomes sharing a criterionId cannot
 * otherwise be attributed to a tenant or a candidate -- and POL-011
 * requires candidate records stay employer-scoped. This function
 * constructs outcomes, so it has to be told; there is nothing in a
 * rubric or a model response that carries it.
 *
 * Passed as one object rather than two positional strings on purpose:
 * two adjacent same-typed parameters are transposable at a call site
 * with nothing to catch it, and transposing these two attributes a
 * candidate's evidence to the wrong organization.
 */
export interface EvidenceSubject {
  readonly organizationId: string;
  readonly candidateId: string;
}

function invalidCitationOutcome(subject: EvidenceSubject, criterionId: string): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    organizationId: subject.organizationId,
    candidateId: subject.candidateId,
    criterionId,
    errorCode: "invalid_citation",
    message: "The model's citing item is missing a persistable source citation.",
    retryable: true
  };
}

function mapExtractedItem(subject: EvidenceSubject, item: EvidenceExtractionItem): EvidenceOutcome {
  const criterionId = item.criterion_id;
  // Written out per branch rather than spread from a shared object: with
  // a spread, `kind: item.state` is a union and TypeScript stops
  // distributing over EvidenceOutcome's discriminated members, so the
  // whole thing fails to narrow. The repetition is what keeps the
  // exhaustiveness real.
  const { organizationId, candidateId } = subject;
  switch (item.state) {
    case "not_found":
      return { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", organizationId, candidateId, criterionId };
    case "contradicted":
      // AF-13 requires both sides of the conflict. AF-35's follow-up
      // (#64) added `conflicting` so a validated contradicted item can
      // carry them. The item type still types that field as nullish
      // (direct-construction fixtures omit it), so the mapper narrows
      // at runtime: both persistable citations become `contradicted`;
      // a missing or unpersistable second side stays a named
      // extraction_error rather than being collapsed to `unclear`.
      {
        const conflictingCitation = conflictingCitationFrom(item);
        if (!citingCitationIsPersistable(item)) {
          return invalidCitationOutcome(subject, criterionId);
        }
        if (conflictingCitation === undefined || !conflictingCitationIsPersistable(item)) {
          return {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            kind: "extraction_error",
            organizationId,
            candidateId,
            criterionId,
            errorCode: "contradiction_missing_conflicting_citation",
            message:
              "The model reported a contradiction but did not supply a persistable conflicting citation; " +
              "a persistable contradicted outcome requires both sides of the conflict.",
            retryable: true
          };
        }
        return {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          kind: "contradicted",
          organizationId,
          candidateId,
          criterionId,
          citation: citationFrom(item),
          conflictingCitation
        };
      }
    case "supported":
    case "partially_supported":
    case "unclear":
      if (!citingCitationIsPersistable(item)) {
        return invalidCitationOutcome(subject, criterionId);
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        kind: item.state,
        organizationId,
        candidateId,
        criterionId,
        citation: citationFrom(item)
      };
  }
}

function omittedCriterionOutcome(subject: EvidenceSubject, criterionId: string): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    organizationId: subject.organizationId,
    candidateId: subject.candidateId,
    criterionId,
    errorCode: "model_omitted_criterion",
    message: "The model's response did not include this criterion.",
    retryable: true
  };
}

function duplicateCriterionOutcome(subject: EvidenceSubject, criterionId: string, count: number): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    organizationId: subject.organizationId,
    candidateId: subject.candidateId,
    criterionId,
    errorCode: "duplicate_criterion_response",
    message: `The model returned ${count} responses for one criterion.`,
    retryable: true
  };
}

export function mapRubricToEvidence(
  subject: EvidenceSubject,
  rubricCriterionIds: readonly string[],
  extractedItems: readonly EvidenceExtractionItem[]
): EvidenceOutcome[] {
  // Validated for the same reason the criterion IDs below are, and the
  // comment there states it: this function advertises its output as
  // persistable EvidenceOutcomes, and evidenceOutcomeSchema requires a
  // UUID organizationId and a non-empty candidateId. A nonempty but
  // non-UUID organizationId (for example "org-1") used to pass a
  // whitespace-only check and then fail every contract branch at persist
  // time. Constructing outcomes carrying an unpersistable attribution
  // would surface that failure far from here.
  if (subject.candidateId.trim().length === 0) {
    throw new Error("mapRubricToEvidence requires a non-empty candidateId");
  }
  if (!z.uuid().safeParse(subject.organizationId).success) {
    throw new Error("mapRubricToEvidence requires a UUID organizationId");
  }
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
      return omittedCriterionOutcome(subject, criterionId);
    }
    if (rest.length > 0) {
      return duplicateCriterionOutcome(subject, criterionId, matches.length);
    }
    return mapExtractedItem(subject, firstMatch);
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
  | "injection_indicator_detected";

export interface RoutingSignals {
  readonly unreadableInput: boolean;
  readonly citationFailed: boolean;
  readonly contradictionDetected: boolean;
  readonly injectionIndicatorDetected: boolean;
}

/**
 * Signal to reason, as one ordered table rather than four if-blocks.
 *
 * Every reason is the snake_case of the signal that raises it. That was
 * true of three of the four and not the fourth --
 * `injectionIndicatorDetected` reported `injection_indicator`, dropping
 * the `_detected` the other pair keeps -- which is the kind of drift that
 * survives review precisely because each line reads fine on its own. A
 * reason is a value that ends up in audit logs and analytics, so a name
 * that does not match its signal makes the two impossible to join without
 * a lookup nobody writes down.
 *
 * Holding the pairs in one table means the correspondence is a single
 * fact that can be asserted, rather than four independent facts that can
 * each rot separately. The order is the order reasons are reported in,
 * and is load-bearing for callers that render them.
 */
export const ESCALATION_SIGNAL_REASONS: readonly (readonly [keyof RoutingSignals, EscalationReason])[] = [
  ["unreadableInput", "unreadable_input"],
  ["citationFailed", "citation_failed"],
  ["contradictionDetected", "contradiction_detected"],
  ["injectionIndicatorDetected", "injection_indicator_detected"]
];

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
  const reasons = ESCALATION_SIGNAL_REASONS.filter(([signal]) => signals[signal]).map(
    ([, reason]) => reason
  );

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

function toCitationInvalid(
  outcome: SupportedEvidence | PartiallySupportedEvidence | ContradictedEvidence | UnclearEvidence,
  rejectedCitation: SourceCitation,
  reason: string
): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    organizationId: outcome.organizationId,
    candidateId: outcome.candidateId,
    criterionId: outcome.criterionId,
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

  const { citation } = outcome;

  if (citation.quote.length === 0) {
    return toCitationInvalid(outcome, citation, "missing quote for a citing state");
  }
  if (!sourceText.includes(citation.quote)) {
    return toCitationInvalid(
      outcome,
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
      outcome,
      citation,
      "claimed offset is past the end of the source text"
    );
  }

  if (citation.offset >= 0) {
    const window = sourceCodePoints
      .slice(citation.offset, citation.offset + [...citation.quote].length)
      .join("");
    if (window !== citation.quote) {
      return toCitationInvalid(outcome, citation, "quote exists in source but not at the claimed offset");
    }
  }

  return outcome;
}
