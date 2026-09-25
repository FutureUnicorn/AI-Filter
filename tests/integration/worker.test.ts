import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { GET as getWebEnvironmentHealth } from "../../apps/web/src/app/health/environment/route.ts";
import {
  createWorkerHealthServer,
  createWorkerRuntimeId,
  startWorker
} from "../../apps/worker/src/index.ts";

test("worker starts without external credentials", () => {
  assert.equal(
    startWorker(),
    "Signal Audit worker ready; dependency center=domain"
  );
});

test("worker runtime identities are unique per boot and remain lease-safe", () => {
  const first = createWorkerRuntimeId("evidence-worker-staging", "boot-a");
  const second = createWorkerRuntimeId("evidence-worker-staging", "boot-b");
  assert.notEqual(first, second);
  assert.equal(first, "evidence-worker-staging:boot-a");
  assert.match(first, /^[A-Za-z0-9._:-]{1,128}$/u);
  assert.ok(
    createWorkerRuntimeId("w".repeat(128), "boot-c").length <= 128,
    "configured deployment labels must be truncated before adding the unique boot suffix"
  );
});

function findHealthFailureLog(
  calls: readonly { readonly arguments: readonly unknown[] }[],
  event: "web.environment_health_failed" | "worker.environment_health_failed"
): Record<string, unknown> {
  const line = calls
    .map((call) => String(call.arguments[0]))
    .find((value) => value.includes(`"message":"${event}"`));
  assert.ok(line !== undefined, `${event} must be written to the structured error stream`);
  return JSON.parse(line) as Record<string, unknown>;
}

test("worker health failures retain bounded diagnostics without changing the 503 response", async (t) => {
  const errorLog = t.mock.method(console, "error", () => undefined);
  const server = createWorkerHealthServer({});
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/health/environment`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "unavailable" });
  const entry = findHealthFailureLog(errorLog.mock.calls, "worker.environment_health_failed");
  assert.deepEqual(entry.context, {
    errorName: "Error",
    errorCode: "unknown_error",
    statusCode: 503
  });
  assert.doesNotMatch(JSON.stringify(entry), /DATABASE_URL|STORAGE_SECRET_ACCESS_KEY|candidate@example\.test/u);
});

test("web health failures retain bounded diagnostics without changing the 503 response", async (t) => {
  const previousAppEnv = process.env.APP_ENV;
  t.after(() => {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
  });
  process.env.APP_ENV = "invalid-health-test-environment";
  const errorLog = t.mock.method(console, "error", () => undefined);

  const response = await getWebEnvironmentHealth();

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "misconfigured",
    components: { database: "unknown", storage: "unknown" }
  });
  const entry = findHealthFailureLog(errorLog.mock.calls, "web.environment_health_failed");
  assert.deepEqual(entry.context, {
    errorName: "Error",
    errorCode: "unknown_error",
    statusCode: 503
  });
  assert.doesNotMatch(JSON.stringify(entry), /invalid-health-test-environment|DATABASE_URL|candidate@example\.test/u);
});
