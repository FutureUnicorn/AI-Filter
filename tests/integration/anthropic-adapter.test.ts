import assert from "node:assert/strict";
import test from "node:test";

import {
  AiCallNotStartedError,
  AiOutputTruncatedError,
  AiStructuredCallParseError,
  AiUsageUnavailableError,
  InferenceKillSwitchEngagedError,
  ProviderHttpError,
  alwaysDisengagedKillSwitch,
  createAnthropicAdapter
} from "../../packages/ai/src/index.ts";
import type { AnthropicMessagesClient } from "../../packages/ai/src/index.ts";

const baseInput = {
  promptVersion: "v1",
  schemaVersion: "1.0.0",
  schemaName: "evidence_response",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
  systemPrompt: "Bounded to the supplied text.",
  userPrompt: "Rubric: ...\nApplication text: ..."
};

const config = { apiKey: "sk-ant-test", model: "claude-test", checkKillSwitch: alwaysDisengagedKillSwitch };

function fakeClient(
  response: Awaited<ReturnType<AnthropicMessagesClient["create"]>>,
  capture?: { params?: unknown }
): AnthropicMessagesClient {
  return {
    async create(params) {
      if (capture !== undefined) capture.params = params;
      return response;
    }
  };
}

test("returns the forced tool input as output and records anthropic metadata", async () => {
  const adapter = createAnthropicAdapter(
    config,
    fakeClient({
      content: [{ type: "tool_use", name: "evidence_response", input: { items: [] } }],
      model: "claude-test-20260101",
      usage: { input_tokens: 100, output_tokens: 20 }
    })
  );
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.output, { items: [] });
  assert.deepEqual(result.metadata, {
    provider: "anthropic",
    model: "claude-test",
    resolvedModel: "claude-test-20260101",
    promptVersion: "v1",
    schemaVersion: "1.0.0",
    schemaName: "evidence_response",
    usage: { inputTokens: 100, outputTokens: 20 }
  });
});

test("forces a single tool call carrying the caller's schema", async () => {
  const capture: { params?: Parameters<AnthropicMessagesClient["create"]>[0] } = {};
  const adapter = createAnthropicAdapter(
    config,
    fakeClient(
      { content: [{ type: "tool_use", name: "evidence_response", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
      capture
    )
  );
  await adapter.runStructuredCall(baseInput);
  assert.deepEqual(capture.params?.tool_choice, { type: "tool", name: "evidence_response" });
  assert.equal(capture.params?.tools[0]?.input_schema, baseInput.jsonSchema);
  assert.equal(capture.params?.system, baseInput.systemPrompt);
  assert.equal(capture.params?.max_tokens, 4096);
});

test("uses a configured output-token ceiling", async () => {
  const capture: { params?: Parameters<AnthropicMessagesClient["create"]>[0] } = {};
  const adapter = createAnthropicAdapter(
    { ...config, maxOutputTokens: 8192 },
    fakeClient(
      { content: [{ type: "tool_use", name: "evidence_response", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
      capture
    )
  );
  await adapter.runStructuredCall(baseInput);
  assert.equal(capture.params?.max_tokens, 8192);
});

test("a max-token stop is a distinct retryable parse failure carrying real usage", async () => {
  const adapter = createAnthropicAdapter(
    config,
    fakeClient({
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "evidence_response", input: { items: [] } }],
      usage: { input_tokens: 7, output_tokens: 4096 }
    })
  );
  await assert.rejects(adapter.runStructuredCall(baseInput), (error: unknown) => {
    assert.ok(error instanceof AiOutputTruncatedError);
    assert.ok(error instanceof AiStructuredCallParseError);
    assert.deepEqual(error.metadata.usage, { inputTokens: 7, outputTokens: 4096 });
    return true;
  });
});

test("an invalid output-token ceiling is rejected before a provider call", () => {
  assert.throws(
    () => createAnthropicAdapter({ ...config, maxOutputTokens: 0 }),
    /positive safe integer/u
  );
});

test("a response without the tool output is a parse error that still carries usage", async () => {
  const adapter = createAnthropicAdapter(
    config,
    fakeClient({ content: [{ type: "text" }], usage: { input_tokens: 7, output_tokens: 3 } })
  );
  await assert.rejects(adapter.runStructuredCall(baseInput), (error: unknown) => {
    assert.ok(error instanceof AiStructuredCallParseError);
    assert.deepEqual(error.metadata.usage, { inputTokens: 7, outputTokens: 3 });
    return true;
  });
});

test("missing usage fails closed instead of counting as free", async () => {
  const adapter = createAnthropicAdapter(
    config,
    fakeClient({ content: [{ type: "tool_use", name: "evidence_response", input: {} }] })
  );
  await assert.rejects(adapter.runStructuredCall(baseInput), AiUsageUnavailableError);
});

test("malformed usage fails closed and malformed content retains valid usage", async () => {
  const malformedUsage = createAnthropicAdapter(
    config,
    fakeClient({
      content: [{ type: "tool_use", name: "evidence_response", input: {} }],
      usage: { input_tokens: Number.NaN, output_tokens: 1 }
    })
  );
  await assert.rejects(malformedUsage.runStructuredCall(baseInput), AiUsageUnavailableError);

  const malformedContent = createAnthropicAdapter(
    config,
    fakeClient({ usage: { input_tokens: 7, output_tokens: 3 } })
  );
  await assert.rejects(malformedContent.runStructuredCall(baseInput), (error: unknown) => {
    assert.ok(error instanceof AiStructuredCallParseError);
    assert.deepEqual(error.metadata.usage, { inputTokens: 7, outputTokens: 3 });
    return true;
  });
});

test("an engaged kill switch prevents the provider call", async () => {
  let called = false;
  const adapter = createAnthropicAdapter(
    { ...config, checkKillSwitch: async () => ({ engaged: true, reason: "halt" }) },
    {
      async create() {
        called = true;
        throw new Error("must not be called");
      }
    }
  );
  await assert.rejects(adapter.runStructuredCall(baseInput), InferenceKillSwitchEngagedError);
  assert.equal(called, false);
});

test("an invalid schema is rejected before the provider call", async () => {
  const adapter = createAnthropicAdapter(config, fakeClient({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  await assert.rejects(adapter.runStructuredCall({ ...baseInput, jsonSchema: [] }), AiCallNotStartedError);
});

test("Anthropic HTTP failures expose neither response bodies nor API keys", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("candidate text echoed", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(
      createAnthropicAdapter(config).runStructuredCall(baseInput),
      (error: unknown) =>
        error instanceof ProviderHttpError &&
        error.status === 401 &&
        !error.message.includes("candidate") &&
        !error.message.includes(config.apiKey)
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
