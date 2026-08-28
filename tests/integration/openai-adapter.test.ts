import assert from "node:assert/strict";
import test from "node:test";

import { InferenceKillSwitchEngagedError, createOpenAiAdapter } from "../../packages/ai/src/index.ts";
import type { OpenAiResponsesClient } from "../../packages/ai/src/index.ts";

// No real API key, no network call: createOpenAiAdapter's second
// parameter accepts anything shaped like OpenAiResponsesClient, which
// is exactly the point of the port -- this proves the adapter's own
// request/response mapping and metadata recording without touching
// OpenAI at all.

function fakeClient(
  outputText: string,
  capture?: { params?: unknown },
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 120, output_tokens: 45 }
): OpenAiResponsesClient {
  return {
    responses: {
      async create(params) {
        if (capture !== undefined) {
          capture.params = params;
        }
        return { output_text: outputText, usage };
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
    schemaName: "evidence_response",
    usage: { inputTokens: 120, outputTokens: 45 }
  });
});

test("runStructuredCall surfaces the provider's real token usage, not an estimate", async () => {
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6" },
    fakeClient("{}", undefined, { input_tokens: 900, output_tokens: 150 })
  );
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.metadata.usage, { inputTokens: 900, outputTokens: 150 });
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

test("different calls with different prompt/schema versions produce different metadata", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient("{}"));
  const first = await adapter.runStructuredCall(baseInput);
  const second = await adapter.runStructuredCall({ ...baseInput, promptVersion: "v2", schemaVersion: "1.1.0" });
  assert.equal(first.metadata.promptVersion, "v1");
  assert.equal(second.metadata.promptVersion, "v2");
  assert.equal(second.metadata.schemaVersion, "1.1.0");
});

// AF-42: before this, checkKillSwitch didn't exist and nothing in the
// codebase called the kill-switch status check at all -- engaging it
// halted nothing. These prove the provider is genuinely never reached
// when engaged, not just that some error gets thrown.

test("runStructuredCall never calls the provider when the kill switch is engaged", async () => {
  let callCount = 0;
  const client = fakeClient("{}");
  const countingClient: OpenAiResponsesClient = {
    responses: {
      async create(params) {
        callCount += 1;
        return client.responses.create(params);
      }
    }
  };
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: async () => ({ engaged: true, reason: "cost spike" }) },
    countingClient
  );
  await assert.rejects(() => adapter.runStructuredCall(baseInput), InferenceKillSwitchEngagedError);
  assert.equal(callCount, 0);
});

test("InferenceKillSwitchEngagedError carries the operator's reason", async () => {
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: async () => ({ engaged: true, reason: "bad release" }) },
    fakeClient("{}")
  );
  await assert.rejects(
    () => adapter.runStructuredCall(baseInput),
    (error: unknown) => error instanceof InferenceKillSwitchEngagedError && error.reason === "bad release"
  );
});

test("runStructuredCall proceeds normally when checkKillSwitch reports disengaged", async () => {
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: async () => ({ engaged: false }) },
    fakeClient('{"items":[]}')
  );
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.output, { items: [] });
});

test("runStructuredCall proceeds normally when no checkKillSwitch is supplied at all", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6" }, fakeClient('{"items":[]}'));
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.output, { items: [] });
});
