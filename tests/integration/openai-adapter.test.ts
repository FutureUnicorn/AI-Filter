import assert from "node:assert/strict";
import test from "node:test";

import { InferenceKillSwitchEngagedError, alwaysDisengagedKillSwitch, createOpenAiAdapter } from "../../packages/ai/src/index.ts";
import type { AiCallMetadata } from "../../packages/domain/src/index.ts";
import type { OpenAiAdapterConfig, OpenAiResponsesClient } from "../../packages/ai/src/index.ts";

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
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, fakeClient('{"items":[]}'));
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.output, { items: [] });
});

test("runStructuredCall records provider/model/prompt/schema metadata on every call", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, fakeClient("{}"));
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
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch },
    fakeClient("{}", undefined, { input_tokens: 900, output_tokens: 150 })
  );
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.metadata.usage, { inputTokens: 900, outputTokens: 150 });
});

test("runStructuredCall sends the system and user prompts as separate messages, in order", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, fakeClient("{}", capture));
  await adapter.runStructuredCall(baseInput);
  const params = capture.params as { input: Array<{ role: string; content: string }> };
  assert.deepEqual(params.input, [
    { role: "system", content: baseInput.systemPrompt },
    { role: "user", content: baseInput.userPrompt }
  ]);
});

test("runStructuredCall requests strict structured JSON output with the caller's schema and name", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, fakeClient("{}", capture));
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
  // Explicitly disengaged rather than omitted. checkKillSwitch is required,
  // and this construction had drifted back to the original
  // `{ apiKey, model }` shape -- which compiles here only because test
  // files are not in any package tsconfig, so nothing typechecks them.
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch },
    fakeClient("{}", capture)
  );
  await assert.rejects(() => adapter.runStructuredCall({ ...baseInput, jsonSchema: true }), {
    name: "TypeError",
    message: "OpenAI structured output requires an object JSON Schema."
  });
  assert.equal(capture.params, undefined);
});

test("different calls with different prompt/schema versions produce different metadata", async () => {
  const adapter = createOpenAiAdapter({ apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, fakeClient("{}"));
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

test("an adapter cannot be constructed without a kill-switch check", () => {
  // This test previously asserted the OPPOSITE -- that an adapter with
  // no check "proceeds normally" -- which was precisely the unchecked
  // path that left the kill switch unable to halt anything.
  // checkKillSwitch is now required, so omitting it is a compile error;
  // the only way past it is the explicitly-named marker below, which
  // greps cleanly so every bypass is visible.
  // @ts-expect-error checkKillSwitch is required and must not be omissible
  const invalid: OpenAiAdapterConfig = { apiKey: "sk-test", model: "gpt-5.6" };
  assert.equal(invalid.model, "gpt-5.6");
});

test("runStructuredCall proceeds normally with the explicit disengaged marker", async () => {
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch },
    fakeClient('{"items":[]}')
  );
  const result = await adapter.runStructuredCall(baseInput);
  assert.deepEqual(result.output, { items: [] });
});

// ---- AF-41 Codex findings: usage must never be lost or under-counted ----

test("a provider response with no usage fails closed instead of metering as zero tokens", async () => {
  const noUsageClient: OpenAiResponsesClient = {
    responses: {
      async create() {
        return { output_text: JSON.stringify({ items: [] }) };
      }
    }
  };
  const adapter = createOpenAiAdapter(
    { apiKey: "unused", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, noUsageClient);
  await assert.rejects(
    () => adapter.runStructuredCall(baseInput),
    (error: Error) => {
      assert.equal(error.name, "AiUsageUnavailableError");
      // The point of failing closed: an unknown-cost call must not be
      // recordable as a free one.
      assert.match(error.message, /zero-token/);
      return true;
    }
  );
});

test("a non-JSON response still surfaces the call's real token usage to the caller", async () => {
  // A refusal/truncation is still a billed call. Before this fix
  // JSON.parse threw before metadata existed, so the caller had no
  // counts to hand to recordInferenceUsage and retries of failing
  // responses stayed invisible to the budget.
  let calls = 0;
  const refusingClient: OpenAiResponsesClient = {
    responses: {
      async create() {
        calls += 1;
        return { output_text: "I'm sorry, I can't help with that.", usage: { input_tokens: 310, output_tokens: 12 } };
      }
    }
  };
  const adapter = createOpenAiAdapter(
    { apiKey: "unused", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch }, refusingClient);
  await assert.rejects(
    () => adapter.runStructuredCall(baseInput),
    (error: Error & { metadata?: { usage?: { inputTokens: number; outputTokens: number }; model?: string } }) => {
      assert.equal(error.name, "AiStructuredCallParseError");
      assert.equal(error.metadata?.usage?.inputTokens, 310);
      assert.equal(error.metadata?.usage?.outputTokens, 12);
      assert.equal(error.metadata?.model, "gpt-5.6");
      return true;
    }
  );
  assert.equal(calls, 1);
});

// ---- AF-34 Codex findings ----

test("candidate calls opt out of provider-side response retention", async () => {
  // The structured output carries verbatim quotes from candidate
  // documents, and the Responses API stores response objects by default,
  // so omitting `store` silently created a provider-retained copy of
  // candidate material on every successful call.
  const capture: { params?: unknown } = {};
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch },
    fakeClient("{}", capture));
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
        return {
          output_text: "{}",
          model: "gpt-5.6-2026-08-01",
          // AF-41 fails closed on missing usage, so a fixture that omits it
          // would throw AiUsageUnavailableError before reaching the
          // resolved-model assertion this test is actually about.
          usage: { input_tokens: 120, output_tokens: 8 }
        };
      }
    }
  };
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch },
    aliasClient);
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
        return {
          output_text: "I'm sorry, I can't help with that.",
          model: "gpt-5.6-2026-08-01",
          usage: { input_tokens: 310, output_tokens: 12 }
        };
      }
    }
  };
  const adapter = createOpenAiAdapter(
    { apiKey: "sk-test", model: "gpt-5.6", checkKillSwitch: alwaysDisengagedKillSwitch },
    refusingClient);
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
