import assert from "node:assert/strict";
import test from "node:test";

import {
  AiStructuredCallParseError,
  AiUsageUnavailableError,
  InferenceKillSwitchEngagedError,
  ProviderHttpError,
  alwaysDisengagedKillSwitch,
  createAiAdapter,
  createGoogleAdapter,
  createOpenAiCompatibleAdapter
} from "../../packages/ai/src/index.ts";
import type { JsonTextTransport } from "../../packages/ai/src/index.ts";
import { loadWorkerProcessingConfig } from "../../packages/config/src/index.ts";

const input = {
  promptVersion: "v1",
  schemaVersion: "1.0.0",
  schemaName: "evidence_response",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
  systemPrompt: "system",
  userPrompt: "user"
};
const base = { apiKey: "k", model: "m", checkKillSwitch: alwaysDisengagedKillSwitch };

const ok: JsonTextTransport = async () => ({
  text: '{"items":[]}',
  model: "m-resolved",
  usage: { inputTokens: 10, outputTokens: 5 }
});

interface CapturedProviderRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly max_tokens?: number;
    readonly response_format?: { readonly json_schema?: { readonly name?: string } };
    readonly generationConfig?: { readonly responseMimeType?: string };
  };
}

test("google adapter records provider, resolved model and usage", async () => {
  const result = await createGoogleAdapter(base, ok).runStructuredCall(input);
  assert.deepEqual(result.output, { items: [] });
  assert.equal(result.metadata.provider, "google");
  assert.equal(result.metadata.resolvedModel, "m-resolved");
  assert.deepEqual(result.metadata.usage, { inputTokens: 10, outputTokens: 5 });
});

test("openai-compatible adapter records its own provider label", async () => {
  const adapter = createOpenAiCompatibleAdapter({ ...base, baseUrl: "https://example.test/v1" }, ok);
  const result = await adapter.runStructuredCall(input);
  assert.equal(result.metadata.provider, "openai_compatible");
});

test("non-JSON text is a parse error that still carries usage", async () => {
  const adapter = createGoogleAdapter(base, async () => ({ text: "nope", usage: { inputTokens: 3, outputTokens: 1 } }));
  await assert.rejects(adapter.runStructuredCall(input), (error: unknown) => {
    assert.ok(error instanceof AiStructuredCallParseError);
    assert.deepEqual(error.metadata.usage, { inputTokens: 3, outputTokens: 1 });
    return true;
  });
});

test("missing usage fails closed", async () => {
  const adapter = createOpenAiCompatibleAdapter(
    { ...base, baseUrl: "https://example.test/v1" },
    async () => ({ text: "{}" })
  );
  await assert.rejects(adapter.runStructuredCall(input), AiUsageUnavailableError);
});

test("invalid usage fails closed instead of entering the budget ledger", async () => {
  const adapter = createGoogleAdapter(base, async () => ({
    text: "{}",
    usage: { inputTokens: Number.NaN, outputTokens: 1 }
  }));
  await assert.rejects(adapter.runStructuredCall(input), AiUsageUnavailableError);
});

test("kill switch blocks Google and OpenAI-compatible before transport", async () => {
  for (const provider of ["google", "openai_compatible"] as const) {
    let called = false;
    const transport: JsonTextTransport = async () => {
      called = true;
      return { text: "{}" };
    };
    const checkKillSwitch = async () => ({ engaged: true });
    const adapter =
      provider === "google"
        ? createGoogleAdapter({ ...base, checkKillSwitch }, transport)
        : createOpenAiCompatibleAdapter(
            { ...base, baseUrl: "https://example.test/v1", checkKillSwitch },
            transport
          );
    await assert.rejects(adapter.runStructuredCall(input), InferenceKillSwitchEngagedError);
    assert.equal(called, false);
  }
});

test("openai-compatible base URLs require HTTPS except for local loopback", () => {
  for (const baseUrl of ["http://api.example.test/v1", "ftp://api.example.test/v1"]) {
    assert.throws(() => createOpenAiCompatibleAdapter({ ...base, baseUrl }, ok), /must use HTTPS/u);
  }
  for (const baseUrl of [
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1?key=secret",
    "https://api.example.test/v1#fragment"
  ]) {
    assert.throws(() => createOpenAiCompatibleAdapter({ ...base, baseUrl }, ok), /must not contain/u);
  }
  for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
    assert.equal(typeof createOpenAiCompatibleAdapter({ ...base, baseUrl }, ok).runStructuredCall, "function");
  }
});

test("config and adapter boundaries enforce the same OpenAI-compatible base URL policy", () => {
  const cases = [
    ["https://api.example.test/v1", true],
    [" https://api.example.test/v1/ ", true],
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1:11434/v1", true],
    ["http://[::1]:11434/v1", true],
    ["http://api.example.test/v1", false],
    ["ftp://api.example.test/v1", false],
    ["https://user:password@api.example.test/v1", false],
    ["https://api.example.test/v1?key=secret", false],
    ["https://api.example.test/v1#fragment", false],
    ["not a URL", false]
  ] as const;
  for (const [baseUrl, expected] of cases) {
    let configAccepted = true;
    try {
      loadWorkerProcessingConfig({
        WORKER_PROCESSING_ENABLED: "true",
        WORKER_INSTANCE_ID: "worker-1",
        AI_PROVIDER: "openai_compatible",
        AI_API_KEY: "synthetic-key",
        AI_MODEL: "m",
        AI_ESCALATION_MODEL: "m2",
        AI_BASE_URL: baseUrl,
        INFERENCE_MAX_TOKENS_PER_PERIOD: "1000",
        INFERENCE_ALERT_THRESHOLD_RATIO: "0.8",
        INFERENCE_BUDGET_PERIOD: "day"
      });
    } catch {
      configAccepted = false;
    }
    let adapterAccepted = true;
    try {
      createOpenAiCompatibleAdapter({ ...base, baseUrl }, ok);
    } catch {
      adapterAccepted = false;
    }
    assert.equal(configAccepted, expected, `config boundary disagreed for ${baseUrl}`);
    assert.equal(adapterAccepted, expected, `adapter boundary disagreed for ${baseUrl}`);
  }
});

test("the factory builds every provider and requires a base URL for openai_compatible", () => {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    assert.equal(typeof createAiAdapter({ ...base, provider }).runStructuredCall, "function");
  }
  assert.equal(
    typeof createAiAdapter({ ...base, provider: "openai_compatible", baseUrl: "https://example.test/v1" }).runStructuredCall,
    "function"
  );
  assert.throws(() => createAiAdapter({ ...base, provider: "openai_compatible" }), /base URL/u);
});

test("the production factory forwards Anthropic's output-token ceiling", async () => {
  let captured: CapturedProviderRequest["body"] | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string) as CapturedProviderRequest["body"];
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "evidence_response", input: { items: [] } }],
      usage: { input_tokens: 4, output_tokens: 2 }
    }), { status: 200 });
  }) as typeof fetch;
  try {
    await createAiAdapter({ ...base, provider: "anthropic", maxOutputTokens: 8192 }).runStructuredCall(input);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(captured?.max_tokens, 8192);
});

test("openai-compatible and google adapters send the expected wire requests", async () => {
  const calls: CapturedProviderRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as CapturedProviderRequest["body"]
    });
    const body = url.includes("generateContent")
      ? {
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
        }
      : { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    await createOpenAiCompatibleAdapter({ ...base, baseUrl: "https://example.test/v1/" }).runStructuredCall(input);
    await createGoogleAdapter({ ...base, baseUrl: "https://g.test/v1beta" }).runStructuredCall(input);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0]?.url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0]?.headers.authorization, "Bearer k");
  assert.equal(calls[0]?.body.response_format?.json_schema?.name, "evidence_response");
  assert.equal(calls[1]?.url, "https://g.test/v1beta/models/m:generateContent");
  assert.equal(calls[1]?.headers["x-goog-api-key"], "k");
  assert.equal(calls[1]?.body.generationConfig?.responseMimeType, "application/json");
});

test("provider HTTP failures expose only the status", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("candidate text echoed", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(
      createGoogleAdapter(base).runStructuredCall(input),
      (error: unknown) =>
        error instanceof ProviderHttpError &&
        error.status === 401 &&
        !error.message.includes("candidate") &&
        !error.message.includes(base.apiKey)
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
