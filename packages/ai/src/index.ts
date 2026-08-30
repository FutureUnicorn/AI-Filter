import OpenAI from "openai";
import { z } from "zod";

import type { BoundaryContract } from "@signal-audit/contracts";
import { CONTRACT_SCHEMA_VERSION } from "@signal-audit/domain";
import type {
  AiAdapter,
  AiCallMetadata,
  AiStructuredCallInput,
  AiStructuredCallResult,
  DomainPort,
  EvidenceOutcome,
  SourceCitation
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
      // A second defect CI surfaced alongside the missing attribution,
      // and it is not a typing nuisance.
      //
      // AF-13's review made ContradictedEvidence carry BOTH sides of the
      // conflict -- citation AND conflictingCitation -- because a
      // contradiction a reviewer can only see one half of is not
      // reviewable. An extraction item carries one quote. So a single
      // item can no longer produce a persistable contradicted outcome,
      // and constructing one with the second side missing would hand
      // back a value that fails evidenceOutcomeSchema.
      //
      // Reported as a retryable extraction_error naming the real reason,
      // rather than downgraded to `unclear`: a model that found
      // conflicting evidence and a model that found ambiguous evidence
      // are saying different things, and collapsing them would lose the
      // signal this criterion most needs a human for. AF-35's
      // model-facing schema has to grow a second quote for the
      // contradicted state before this can map properly.
      if (!citingCitationIsPersistable(item)) {
        return invalidCitationOutcome(subject, criterionId);
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        kind: "extraction_error",
        organizationId,
        candidateId,
        criterionId,
        errorCode: "contradiction_missing_conflicting_citation",
        message:
          "The model reported a contradiction but the extraction schema supplies only one quote; " +
          "a persistable contradicted outcome requires both sides of the conflict.",
        retryable: true
      };
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
