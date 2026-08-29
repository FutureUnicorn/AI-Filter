import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiAdapter } from "../../packages/ai/src/index.ts";
import type { AiCallMetadata } from "../../packages/domain/src/index.ts";
import type { OpenAiResponsesClient } from "../../packages/ai/src/index.ts";

// No real API key, no network call: createOpenAiAdapter's second
// parameter accepts anything shaped like OpenAiResponsesClient, which
// is exactly the point of the port -- this proves the adapter's own
// request/response mapping and metadata recording without touching
// OpenAI at all.

function fakeClient(outputText: string, capture?: { params?: unknown }): OpenAiResponsesClient {
  return {
    responses: {
      async create(params) {
        if (capture !== undefined) {
          capture.params = params;
        }
        return { output_text: outputText };
      }
    }
  };
}

const baseInput = {
  promptVersion: "v1",
  schemaVersion: "1.0.0",
  schemaName: "evidence_response",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
  systemPrompt: "You are bounded to the supplied text.",
  userPrompt: "Rubric: ...\nApplication text: ..."
};

test("runStructuredCall parses the client's output_text as JSON", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient('{"items":[]}'));
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.output, { items: [] });
});

test("runStructuredCall records provider/model/prompt/schema metadata on every call", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}"));
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.metadata, {
    provider: "openai",
    model: "gpt-5.6",
    promptVersion: "v1",
    schemaVersion: "1.0.0",
    schemaName: "evidence_response"
  });
});

test("runStructuredCall sends the system and user prompts as separate messages, in order", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}", capture));
  await adapter.runStructuredCall(baseInput);
  const params = capture.params as { input: Array<{ role: string; content: string }> };
  assert.deepEqual(params.input, [
    { role: "system", content: baseInput.systemPrompt },
    { role: "user", content: baseInput.userPrompt }
  ]);
});

test("runStructuredCall requests strict structured JSON output with the caller's schema and name", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}", capture));
  await adapter.runStructuredCall(baseInput);
  const params = capture.params as {
    text: { format: { type: string; name: string; schema: unknown; strict: boolean } };
  };
  assert.equal(params.text.format.type, "json_schema");
  assert.equal(params.text.format.name, "evidence_response");
  assert.equal(params.text.format.strict, true);
  assert.deepEqual(params.text.format.schema, baseInput.jsonSchema);
});

test("runStructuredCall rejects JSON Schemas unsupported by OpenAI", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}", capture));
  await assert.rejects(() => adapter.runStructuredCall({ ...baseInput, jsonSchema: true }), {
    name: "TypeError",
    message: "OpenAI structured output requires an object JSON Schema."
  });
  assert.equal(capture.params, undefined);
});

test("different calls with different prompt/schema versions produce different metadata", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}"));
  const first = await adapter.runStructuredCall(baseInput);
  const second = await adapter.runStructuredCall({ ...baseInput, promptVersion: "v2", schemaVersion: "1.1.0" });
  assert.equal(first.metadata.promptVersion, "v1");
  assert.equal(second.metadata.promptVersion, "v2");
  assert.equal(second.metadata.schemaVersion, "1.1.0");
});

// ---- AF-34 Codex findings ----

test("candidate calls opt out of provider-side response retention", async () => {
  // The structured output carries verbatim quotes from candidate
  // documents, and the Responses API stores response objects by default,
  // so omitting `store` silently created a provider-retained copy of
  // candidate material on every successful call.
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}", capture));
  await adapter.runStructuredCall(baseInput);
  assert.equal((capture.params as { store: boolean }).store, false);
});

test("metadata records the provider-resolved model, not just the requested alias", async () => {
  // config.model may be a movable alias; response.model is what actually
  // served the call. Without it, records from different revisions of the
  // same alias are indistinguishable after the alias moves.
  const aliasClient: OpenAiResponsesClient = {
    responses: {
      async create() {
        return { output_text: "{}", model: "gpt-5.6-2026-08-01" };
      }
    }
  };
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, aliasClient);
  const result = await adapter.runStructuredCall(baseInput);
  assert.equal(result.metadata.model, "gpt-5.6");
  assert.equal(result.metadata.resolvedModel, "gpt-5.6-2026-08-01");
});

test("a non-JSON response still carries full call metadata to the caller", async () => {
  // A refusal or truncation is still a call that happened. Building
  // metadata after JSON.parse meant the throw destroyed every trace of
  // it, leaving AF-40 unable to audit failed calls.
  const refusingClient: OpenAiResponsesClient = {
    responses: {
      async create() {
        return { output_text: "I'm sorry, I can't help with that.", model: "gpt-5.6-2026-08-01" };
      }
    }
  };
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, refusingClient);
  await assert.rejects(
    () => adapter.runStructuredCall(baseInput),
    (error: Error & { metadata?: AiCallMetadata }) => {
      assert.equal(error.name, "AiStructuredCallParseError");
      assert.equal(error.metadata?.provider, "openai");
      assert.equal(error.metadata?.model, "gpt-5.6");
      assert.equal(error.metadata?.resolvedModel, "gpt-5.6-2026-08-01");
      assert.equal(error.metadata?.promptVersion, baseInput.promptVersion);
      assert.equal(error.metadata?.schemaName, baseInput.schemaName);
      return true;
    }
  );
});
