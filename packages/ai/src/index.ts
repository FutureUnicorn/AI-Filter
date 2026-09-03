import OpenAI from "openai";
import { z } from "zod";

import { sourceCitationSchema } from "@signal-audit/contracts";
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
  EvidenceOutcomeKind,
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

/**
 * Every function that advertises persistable EvidenceOutcomes has to agree
 * on what a valid attribution is, or one constructs outcomes the other's
 * rules reject and the failure surfaces at persist time, far from the
 * cause. evidenceOutcomeSchema requires a UUID organizationId and a
 * non-empty candidateId; a nonempty but non-UUID organizationId such as
 * "org-1" used to pass a whitespace-only check and then fail every
 * contract branch later.
 */
function assertPersistableSubject(subject: EvidenceSubject, fn: string): void {
  if (subject.candidateId.trim().length === 0) {
    throw new Error(`${fn} requires a non-empty candidateId`);
  }
  if (!z.uuid().safeParse(subject.organizationId).success) {
    throw new Error(`${fn} requires a UUID organizationId`);
  }
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
  assertPersistableSubject(subject, "mapRubricToEvidence");
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

/**
 * Renders a rejected proposal in a form that survives JSON.
 *
 * citation_invalid exists to preserve what was rejected, and the offset
 * guard above deliberately rejects NaN and the infinities -- which are
 * exactly the values JSON cannot carry. jsonValueSchema enforces
 * `.finite()`, so copying the citation through verbatim produced a
 * citation_invalid that itself failed evidenceOutcomeSchema: unpersistable,
 * unroutable, and therefore invisible to the human review this kind is for.
 * That is the same failure that made rejectedCitation `unknown` in the
 * first place, reached one layer further down.
 *
 * Non-finite numbers become their string form ("NaN", "Infinity") rather
 * than being dropped or zeroed. A reviewer still sees exactly what was
 * claimed, and the outcome persists.
 */
function jsonSafeRejection(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafeRejection);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafeRejection(v)])
    );
  }
  return value;
}

function toCitationInvalid(
  outcome: SupportedEvidence | PartiallySupportedEvidence | ContradictedEvidence | UnclearEvidence,
  rejectedCitation: unknown,
  reason: string
): EvidenceOutcome {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "citation_invalid",
    organizationId: outcome.organizationId,
    candidateId: outcome.candidateId,
    criterionId: outcome.criterionId,
    reason,
    rejectedCitation: jsonSafeRejection(rejectedCitation)
  };
}

/**
 * The text a citation must be checked against, or undefined when none was
 * supplied for the document it names.
 *
 * The string form carries no document identifier, so it cannot and does
 * not check which document the PRIMARY citation names: passing a string
 * asserts "this is the text of whatever document this outcome cites", and
 * that assertion is the caller's, not something this function verifies.
 * What it does enforce is internal consistency -- a CONFLICTING citation
 * naming a different document than the primary is refused, because there
 * is no text here to check it against. Silently checking a cover-letter
 * quote against the resume would report a real citation as a
 * hallucination, and silently skipping it would let an unchecked one
 * through.
 *
 * The map form is what actually verifies documents: each citation is
 * looked up by the document it names, so a citation naming a document the
 * caller did not supply is refused rather than checked against the wrong
 * text.
 */
export type CitationSources = string | ReadonlyMap<string, string>;

function sourceTextFor(
  citation: SourceCitation,
  sources: CitationSources,
  singleDocument: string
): string | undefined {
  if (typeof sources === "string") {
    return citation.document === singleDocument ? sources : undefined;
  }
  return sources.get(citation.document);
}

/**
 * Why one citation fails, or undefined if it holds up.
 *
 * Extracted so both sides of a contradiction are checked by the same
 * rules. Two copies of these four checks would drift, and the side that
 * drifted would be the one nobody was looking at.
 */
function citationFailureReason(citation: SourceCitation, sourceText: string): string | undefined {
  if (citation.quote.length === 0) {
    return "missing quote for a citing state";
  }
  if (!sourceText.includes(citation.quote)) {
    return "quote not found verbatim in source text (likely hallucination)";
  }
  // Placed AFTER the substring check, deliberately: if the quote is not in
  // the source at all, "hallucination" is the accurate diagnosis and a
  // complaint about the offset would send a reviewer to the wrong problem.
  // An offset only means anything for a quote that exists.
  //
  // NaN and any negative offset make both `>= sourceCodePoints.length` and
  // `>= 0` false, so the check below was SKIPPED ENTIRELY and the outcome
  // passed on the substring match alone -- the same shape as the
  // out-of-range bug fixed earlier in this file, reached by a different
  // input. A fractional offset is worse than skipped: slice() truncates, so
  // 0.5 silently verified position 0 and reported the citation as valid at
  // a location it never claimed.
  //
  // sourceCitationSchema already says offset is z.number().int().min(0);
  // this function inspects model output that has not necessarily been
  // through it, so the same rule is enforced rather than assumed.
  if (!Number.isSafeInteger(citation.offset) || citation.offset < 0) {
    return "claimed offset is not a non-negative whole number";
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
    return "claimed offset is past the end of the source text";
  }

  {
    const window = sourceCodePoints
      .slice(citation.offset, citation.offset + [...citation.quote].length)
      .join("");
    if (window !== citation.quote) {
      return "quote exists in source but not at the claimed offset";
    }
  }

  return undefined;
}

/**
 * Non-citing outcomes pass through unexamined -- there is nothing to
 * validate and no citation field to inspect. A citing outcome whose
 * quote fails this check is discarded and replaced with
 * `citation_invalid`, carrying the rejected citation and why, ready for
 * AF-39 to route to human review.
 *
 * A `contradicted` outcome is the case that needs saying explicitly,
 * because it carries TWO citations and only one of them used to be
 * checked. A contradiction is a claim about both cited facts at once, so
 * a hallucinated opposing side is not half-valid evidence -- it is a
 * fabricated conflict, and the more damaging half to get wrong, since it
 * is the side that argues against the candidate. Validating only the
 * primary let such an outcome reach a reviewer as valid `contradicted`
 * evidence, with the fabricated quote displayed beside a real one that
 * lent it credibility.
 */
export function validateCitation(outcome: EvidenceOutcome, sources: CitationSources): EvidenceOutcome {
  if (!isCitingEvidence(outcome)) {
    return outcome;
  }

  // isCitingEvidence narrows on `kind` alone, which is all it can do for a
  // payload that has not been through the schema. A model response
  // claiming kind "supported" with no citation field would then throw a
  // TypeError out of a validator whose entire job is inspecting untrusted
  // output. Fails closed instead.
  const citation = (outcome as { citation?: SourceCitation }).citation;
  if (citation === null || typeof citation !== "object") {
    // `null`, not the absent value: undefined is not a JSON value, so
    // passing it through would produce yet another citation_invalid that
    // cannot be persisted -- the same trap this branch exists to close.
    return toCitationInvalid(
      outcome,
      citation ?? null,
      "citing outcome carries no citation, so there is nothing to verify"
    );
  }

  const primaryText = typeof sources === "string" ? sources : sources.get(citation.document);
  if (primaryText === undefined) {
    return toCitationInvalid(
      outcome,
      citation,
      `no source text was supplied for document "${citation.document}", so this citation cannot be verified`
    );
  }

  const primaryFailure = citationFailureReason(citation, primaryText);
  if (primaryFailure !== undefined) {
    return toCitationInvalid(outcome, citation, primaryFailure);
  }

  if (outcome.kind === "contradicted") {
    // Typed as required, checked anyway. This function's entire job is
    // validating model output that has crossed a trust boundary, and a
    // static type is not a runtime guarantee about such data -- a
    // contradicted outcome that arrives with one side missing must fail
    // closed here rather than throw a TypeError out of a validator.
    const conflicting = outcome.conflictingCitation as SourceCitation | undefined;
    if (conflicting === undefined) {
      return toCitationInvalid(
        outcome,
        citation,
        "contradicted outcome carries no conflicting citation, so the contradiction has only one side"
      );
    }
    const conflictingText = sourceTextFor(conflicting, sources, citation.document);
    if (conflictingText === undefined) {
      // Fails closed. An unverifiable citation is not a valid one, and a
      // contradiction resting on an unchecked quote is exactly the thing
      // this validator exists to keep away from reviewers.
      return toCitationInvalid(
        outcome,
        conflicting,
        `conflicting citation names document "${conflicting.document}", for which no source text was ` +
          `supplied; pass a document-to-text map to validate a cross-document contradiction`
      );
    }
    const conflictingFailure = citationFailureReason(conflicting, conflictingText);
    if (conflictingFailure !== undefined) {
      return toCitationInvalid(outcome, conflicting, `conflicting citation: ${conflictingFailure}`);
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
  subject: EvidenceSubject,
  rubricCriterionIds: readonly string[],
  failure: SchemaValidationFailure
): EvidenceOutcome[] {
  // Takes the subject for the same reason mapRubricToEvidence does: every
  // EvidenceOutcome kind carries organizationId and candidateId, and an
  // outcome without them is neither persistable nor attributable to a
  // tenant. Missing them here did not merely fail to compile -- it meant
  // the one path that exists to keep a rejected payload visible to a human
  // produced outcomes that could never be stored.
  assertPersistableSubject(subject, "outcomesForSchemaValidationFailure");
  const summary = summarizeSchemaValidationFailure(failure);
  return rubricCriterionIds.map((criterionId) => ({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "extraction_error",
    organizationId: subject.organizationId,
    candidateId: subject.candidateId,
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

export function killSwitchRetryOutcome(
  subject: EvidenceSubject,
  criterionId: string,
  attempt: number,
  maxAttempts: number
): EvidenceOutcome {
  // Same reason mapRubricToEvidence and outcomesForSchemaValidationFailure
  // take a subject: every EvidenceOutcome kind carries organizationId and
  // candidateId. A `retrying` outcome without them is not persistable, and
  // this is the outcome that represents work deferred by the kill switch --
  // exactly the state that has to survive until someone picks it back up.
  assertPersistableSubject(subject, "killSwitchRetryOutcome");
  // Checked here, where the caller is, rather than left to the schema. This
  // function's whole promise is a persistable outcome, and
  // `retryingEvidenceSchema` requires both counters to be positive integers
  // with attempt <= maxAttempts. A zero, a fraction, or an attempt past the
  // maximum is accepted here and then rejected at the write, so paused work
  // fails only at the moment someone tries to save it: the point at which the
  // kill switch was supposed to have safely deferred it.
  for (const [field, value] of [
    ["attempt", attempt],
    ["maxAttempts", maxAttempts]
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`killSwitchRetryOutcome requires a positive integer ${field}, got: ${value}`);
    }
  }
  if (attempt > maxAttempts) {
    throw new Error(
      `killSwitchRetryOutcome cannot describe attempt ${attempt} of ${maxAttempts}; an exhausted retry is not a retrying outcome`
    );
  }
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "retrying",
    organizationId: subject.organizationId,
    candidateId: subject.candidateId,
    criterionId,
    attempt,
    maxAttempts
  };
}

// ---- AF-43: gold-set regression harness ----
//
// Scores the real deterministic pipeline stages (mapRubricToEvidence,
// validateCitation, routeForReview) against a versioned, synthetic gold
// set -- never a live model call, matching evals/README.md's own rule
// that standard validation must not require provider credentials. This
// is a self-consistency harness: it proves the deterministic code
// produces the expected result for a known, hand-authored input, so it
// catches a regression in mapping/validation/routing logic. It cannot
// and does not claim anything about how well a real model performs --
// that needs a separate, provider-cost-incurring eval path this ticket
// does not build.
//
// These are REGRESSION FIXTURES, not a holdout, and the distinction is
// deliberate after review (#26). An earlier revision carried a `locked`
// boolean documented as "never inspect while tuning prompts or
// thresholds". That claim could not hold: the flag, the inputs and the
// expected labels all live in one checked-in JSON file that this test
// imports, so anyone able to change a prompt or a threshold can read the
// answers first and tune against them until CI passes. A policy-only
// flag is an honour-system note, not an independent gate, and leaving it
// in place would have advertised a guarantee the repository cannot
// enforce.
//
// A real holdout needs the cases and their expected outputs to live in
// an access-controlled evaluation asset that only a protected CI
// workflow can read, so the labels are unavailable at tuning time. That
// is infrastructure this ticket does not build -- and note it would also
// put a credential in the path of standard validation, which
// evals/README.md currently forbids -- so it belongs to its own ticket
// rather than being implied here.

/**
 * The gold set is synthetic and offline: no tenant owns these cases, and by
 * evals/README.md's rule the harness never makes a live model call. But
 * `mapRubricToEvidence` builds real EvidenceOutcomes, and every kind now
 * carries organizationId and candidateId, so it requires a subject that
 * `assertPersistableSubject` accepts.
 *
 * A fixed nil-UUID organization plus a candidateId derived from the case ID
 * keeps the harness deterministic (two runs of the same case produce byte-
 * identical outcomes, which is what makes a regression gate meaningful) while
 * being obviously synthetic in any output, rather than borrowing a real
 * organization's UUID.
 */
const GOLD_SET_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";

function goldSetSubject(caseId: string): EvidenceSubject {
  return { organizationId: GOLD_SET_ORGANIZATION_ID, candidateId: `gold-set:${caseId}` };
}

export interface GoldSetCase {
  readonly caseId: string;
  readonly sourceText: string;
  readonly rubricCriterionIds: readonly string[];
  readonly simulatedExtraction: readonly EvidenceExtractionItem[];
  readonly expectedKinds: Readonly<Record<string, EvidenceOutcomeKind>>;
  readonly expectedReviewCriterionIds: readonly string[];
}

export interface GoldSetScore {
  readonly totalCases: number;
  readonly schemaValidityRate: number;
  readonly outcomeAccuracy: number;
  readonly citingPrecision: number;
  readonly citingRecall: number;
  readonly escalationRecall: number;
  /**
   * Of everything routed to human review, how much genuinely warranted
   * it. Recall alone cannot fail when routing over-escalates -- flagging
   * every clean outcome scores a perfect recall -- so precision is what
   * actually catches that regression.
   */
  readonly escalationPrecision: number;
}

const CITING_KINDS: ReadonlySet<EvidenceOutcomeKind> = new Set([
  "supported",
  "partially_supported",
  "contradicted",
  "unclear"
]);

function isCitingKind(kind: EvidenceOutcomeKind): boolean {
  return CITING_KINDS.has(kind);
}

/**
 * A gold-set fixture is hand-authored and versioned -- a typo
 * in one of its labels is a fixture bug, not a pipeline regression, and
 * must never silently produce a passing (or falsely failing) score. Both
 * expectedKinds and expectedReviewCriterionIds are asserted against the
 * case's own rubricCriterionIds so a misspelled or stray key fails loud
 * at eval time instead of being quietly invisible to every metric that
 * only ever looks up expected labels by a real outcome's criterionId.
 */
function assertGoldSetCaseIntegrity(goldCase: GoldSetCase): void {
  const criterionIds = new Set(goldCase.rubricCriterionIds);
  for (const expectedCriterionId of Object.keys(goldCase.expectedKinds)) {
    if (!criterionIds.has(expectedCriterionId)) {
      throw new Error(
        `Gold set case "${goldCase.caseId}" has expectedKinds["${expectedCriterionId}"], which is not one of its rubricCriterionIds -- likely a typo in the fixture.`
      );
    }
  }
  for (const reviewCriterionId of goldCase.expectedReviewCriterionIds) {
    if (!criterionIds.has(reviewCriterionId)) {
      throw new Error(
        `Gold set case "${goldCase.caseId}" has expectedReviewCriterionIds entry "${reviewCriterionId}", which is not one of its rubricCriterionIds -- likely a typo in the fixture.`
      );
    }
  }
}

export function scoreGoldSet(cases: readonly GoldSetCase[]): GoldSetScore {
  let totalItems = 0;
  let validItems = 0;
  let totalCriteria = 0;
  let correctKinds = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let reviewExpectedCount = 0;
  let reviewCorrectlyFlagged = 0;
  let reviewIncorrectlyFlagged = 0;

  for (const goldCase of cases) {
    assertGoldSetCaseIntegrity(goldCase);

    const parsedItems: EvidenceExtractionItem[] = [];
    for (const item of goldCase.simulatedExtraction) {
      totalItems += 1;
      const parsed = evidenceExtractionItemSchema.safeParse(item);
      if (parsed.success) {
        validItems += 1;
        parsedItems.push(parsed.data);
      }
    }

    // Only schema-valid items reach the real mapping/validation pipeline:
    // that pipeline assumes a well-formed EvidenceExtractionItem shape
    // (mapExtractedItem's switch has no default because the type claims
    // to be exhaustive), so a malformed fixture item must lower
    // schemaValidityRate above, not crash everything below.
    const mapped = mapRubricToEvidence(goldSetSubject(goldCase.caseId), goldCase.rubricCriterionIds, parsedItems);
    const validated = mapped.map((outcome) => validateCitation(outcome, goldCase.sourceText));

    for (const outcome of validated) {
      totalCriteria += 1;
      const expectedKind = goldCase.expectedKinds[outcome.criterionId];
      if (expectedKind === outcome.kind) {
        correctKinds += 1;
      }

      const expectedCiting = expectedKind !== undefined && isCitingKind(expectedKind);
      const actualCiting = isCitingKind(outcome.kind);
      if (expectedCiting && actualCiting) {
        truePositive += 1;
      } else if (!expectedCiting && actualCiting) {
        falsePositive += 1;
      } else if (expectedCiting && !actualCiting) {
        falseNegative += 1;
      }
    }

    // Seeded from the case's own expected IDs, not discovered by
    // iterating real outcomes: assertGoldSetCaseIntegrity above already
    // guarantees every one of these IDs has a matching outcome (they are
    // all drawn from rubricCriterionIds, and mapRubricToEvidence always
    // produces exactly one outcome per rubric criterion), so the
    // denominator can never be silently short.
    const uniqueReviewCriterionIds = new Set(goldCase.expectedReviewCriterionIds);
    reviewExpectedCount += uniqueReviewCriterionIds.size;

    // Every validated outcome is routed, not just the expected-review
    // ones. Iterating only the expected IDs meant routeForReview was
    // never called for negative examples, so a regression that flagged
    // `supported` / `partially_supported` / `not_found` for review left
    // escalationRecall at 1 and every other metric untouched -- the gate
    // passed while the system sent ALL clean evidence to human review.
    // Recording the false positives gives that failure a metric to trip.
    for (const outcome of validated) {
      const shouldEscalate = uniqueReviewCriterionIds.has(outcome.criterionId);
      const didEscalate = routeForReview(outcome).needsReview;
      if (shouldEscalate && didEscalate) {
        reviewCorrectlyFlagged += 1;
      } else if (!shouldEscalate && didEscalate) {
        reviewIncorrectlyFlagged += 1;
      }
    }
  }

  return {
    totalCases: cases.length,
    schemaValidityRate: totalItems === 0 ? 1 : validItems / totalItems,
    outcomeAccuracy: totalCriteria === 0 ? 1 : correctKinds / totalCriteria,
    citingPrecision: truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive),
    citingRecall: truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative),
    escalationRecall: reviewExpectedCount === 0 ? 1 : reviewCorrectlyFlagged / reviewExpectedCount,
    escalationPrecision:
      reviewCorrectlyFlagged + reviewIncorrectlyFlagged === 0
        ? 1
        : reviewCorrectlyFlagged / (reviewCorrectlyFlagged + reviewIncorrectlyFlagged)
  };
}

export interface GoldSetThresholds {
  readonly minSchemaValidityRate: number;
  readonly minOutcomeAccuracy: number;
  readonly minCitingPrecision: number;
  readonly minCitingRecall: number;
  readonly minEscalationRecall: number;
  readonly minEscalationPrecision: number;
}

/**
 * This synthetic, hand-authored gold set requires a perfect score:
 * every case has one obviously-correct answer, so anything less than
 * 1.0 means the deterministic pipeline regressed, not that a real
 * model produced an imperfect-but-reasonable answer. Do not relax
 * these to make a failing build pass -- fix the regression instead.
 */
export const GOLD_SET_V1_THRESHOLDS: GoldSetThresholds = {
  minSchemaValidityRate: 1,
  minOutcomeAccuracy: 1,
  minCitingPrecision: 1,
  minCitingRecall: 1,
  minEscalationRecall: 1,
  minEscalationPrecision: 1
};

export type GoldSetGate =
  | { readonly passed: true }
  | { readonly passed: false; readonly failures: readonly string[] };

export function checkGoldSetThresholds(score: GoldSetScore, thresholds: GoldSetThresholds): GoldSetGate {
  const failures: string[] = [];
  if (score.schemaValidityRate < thresholds.minSchemaValidityRate) {
    failures.push(`schemaValidityRate ${score.schemaValidityRate} < ${thresholds.minSchemaValidityRate}`);
  }
  if (score.outcomeAccuracy < thresholds.minOutcomeAccuracy) {
    failures.push(`outcomeAccuracy ${score.outcomeAccuracy} < ${thresholds.minOutcomeAccuracy}`);
  }
  if (score.citingPrecision < thresholds.minCitingPrecision) {
    failures.push(`citingPrecision ${score.citingPrecision} < ${thresholds.minCitingPrecision}`);
  }
  if (score.citingRecall < thresholds.minCitingRecall) {
    failures.push(`citingRecall ${score.citingRecall} < ${thresholds.minCitingRecall}`);
  }
  if (score.escalationRecall < thresholds.minEscalationRecall) {
    failures.push(`escalationRecall ${score.escalationRecall} < ${thresholds.minEscalationRecall}`);
  }
  if (score.escalationPrecision < thresholds.minEscalationPrecision) {
    failures.push(`escalationPrecision ${score.escalationPrecision} < ${thresholds.minEscalationPrecision}`);
  }
  return failures.length === 0 ? { passed: true } : { passed: false, failures };
}

// ---- AF-44: resume prompt-injection detection ----
//
// Resumes are untrusted input (SYSTEM_POLICY in scripts/extract_evidence.py
// already says this). "Confirm the model never follows embedded
// instructions" needs a live model call to verify -- that is the
// provider-cost-incurring eval path AF-43 explicitly does not build,
// not something a regex scan can prove. What this file provides
// instead, and what "the pipeline quarantines/flags them" actually
// asks for: a deterministic, regression-tested pre-filter that catches
// known instruction-injection phrasings before or alongside a model
// call, and a function turning a detection into the quarantine outcome
// the ticket names. This is a heuristic first layer, not a claim of
// completeness -- no regex list catches every possible phrasing, and
// the regression suite (tests/) exists specifically so new bypasses
// found later get added here as new cases, not just fixed once.

/**
 * `you are now (a|an)` and bare `system prompt` were originally
 * unqualified, unlike every other entry here -- both matched ordinary
 * resume language with no instructional intent at all ("Designed system
 * prompts and evaluation tooling", "You are now a much stronger
 * communicator"), which a real LLM/prompt-engineering candidate's resume
 * would trigger on sight. Both are narrowed to the actual attack shape:
 * a role-hijack addressed at an assistant/model/bot, or an instructional
 * verb (ignore/disregard/override/bypass/forget) acting on the system
 * prompt specifically. The bracket-marker and "reveal ... system prompt"
 * patterns below already cover the other real system-prompt attack
 * shapes, so this one only needs to add the "override it" shape they
 * don't.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any )?(the )?(previous|prior|above) instructions?/iu,
  /disregard (all |any )?(the )?(previous|prior|above) instructions?/iu,
  /you are now (a|an) [\w\s]{0,30}(assistant|ai\b|model|chatbot|bot|agent)\b/iu,
  /new instructions?:/iu,
  /(ignore|disregard|override|bypass|forget)[\w\s]{0,40}system prompt/iu,
  /reveal (your |the )?(system prompt|instructions)/iu,
  /act as (a|an)\b.{0,40}(instead|from now)/iu,
  /do not (follow|apply|use) (the )?(rubric|criteria|scoring)/iu,
  /overrid(e|ing) (the )?(evaluation|scoring|rubric)/iu,
  /mark (this|me) as (qualified|supported|approved|hired|a match)/iu,
  /\[\s*system\s*\]/iu,
  /<\|im_start\|>/iu
];

export interface PromptInjectionScanResult {
  readonly detected: boolean;
  readonly matchedPatterns: readonly string[];
}

export function scanForPromptInjection(text: string): PromptInjectionScanResult {
  const matchedPatterns = INJECTION_PATTERNS.filter((pattern) => pattern.test(text)).map(
    (pattern) => pattern.source
  );
  return { detected: matchedPatterns.length > 0, matchedPatterns };
}

/**
 * A detected injection quarantines every criterion for the document,
 * not just one: if the source material itself is adversarial, every
 * extraction attempt against it is suspect, not only the criterion
 * whose text happened to contain the pattern.
 */
export function quarantineForInjection(
  criterionIds: readonly string[],
  matchedPatterns: readonly string[]
): EvidenceOutcome[] {
  const reason = `Prompt-injection indicator detected: ${matchedPatterns.join(", ")}`;
  return criterionIds.map((criterionId) => ({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "quarantined",
    criterionId,
    quarantineClass: "malicious",
    reason,
    operatorActionRequired: true
  }));
}
