import OpenAI from "openai";

import type { BoundaryContract } from "@signal-audit/contracts";
import type {
  AiAdapter,
  AiCallMetadata,
  AiStructuredCallInput,
  AiStructuredCallResult,
  DomainPort
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
