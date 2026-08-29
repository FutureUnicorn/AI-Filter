import OpenAI from "openai";
import { z } from "zod";

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
          schema: Record<string, unknown>;
          strict: true;
        };
      };
    }): Promise<{ output_text: string }>;
  };
}

export interface OpenAiAdapterConfig {
  readonly apiKey: string;
  readonly model: string;
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
          text: params.text
        });
        return { output_text: response.output_text };
      }
    }
  };
}

export function createOpenAiAdapter(
  config: OpenAiAdapterConfig,
  client?: OpenAiResponsesClient
): AiAdapter {
  const openai: OpenAiResponsesClient = client ?? wrapRealOpenAiClient(new OpenAI({ apiKey: config.apiKey }));

  return {
    async runStructuredCall(input: AiStructuredCallInput): Promise<AiStructuredCallResult> {
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
        }
      });

      const output: unknown = JSON.parse(response.output_text);
      const metadata: AiCallMetadata = {
        provider: "openai",
        model: config.model,
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        schemaName: input.schemaName
      };
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
