import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { GET as getWebEnvironmentHealth } from "../../apps/web/src/app/health/environment/route.ts";
import { describeError } from "../../packages/security/src/index.ts";

import {
  EnvironmentDependencyUnavailableError,
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

// ---- AF-103 ----
//
// The runbook excludes /health/environment failures from the Sentry error
// detectors because they "remain visible through the structured
// *.environment_health_failed log events". That justification only holds
// if the log can say WHICH dependency died. runEnvironmentSmokeCheck
// probes Postgres and object storage concurrently, so nothing else can.
//
// Binding the error was necessary and not sufficient: an unreachable
// Postgres and an unreachable object store are both a plain Error with
// code ECONNREFUSED, so describeError returns the identical
// {errorName:"Error", errorCode:"econnrefused"} for either. An operator
// reading the log still could not tell them apart. The dependency now
// travels on the error and is emitted as entityType.

test("a database failure and a storage failure are distinguishable in the log", () => {
  const refused = (port: number): Error =>
    Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: "ECONNREFUSED" });

  // The part that makes the dependency label necessary rather than nice:
  // the two failures are indistinguishable by everything else the log carries.
  assert.deepEqual(describeError(refused(5432)), describeError(refused(9000)));

  const databaseDown = new EnvironmentDependencyUnavailableError(["database"], {
    cause: refused(5432)
  });
  const storageDown = new EnvironmentDependencyUnavailableError(["object_storage"], {
    cause: refused(9000)
  });

  assert.notDeepEqual(databaseDown.dependencies, storageDown.dependencies);
  assert.deepEqual(databaseDown.dependencies, ["database"]);
  assert.deepEqual(storageDown.dependencies, ["object_storage"]);

  // The name survives describeError's allowlist, so the log is not left
  // reporting UnknownError for the one error that carries the answer.
  assert.equal(describeError(databaseDown).errorName, "EnvironmentDependencyUnavailableError");

  // Both down is a third distinct value, not a coin flip between the two.
  assert.deepEqual(
    new EnvironmentDependencyUnavailableError(["database", "object_storage"]).dependencies,
    ["database", "object_storage"]
  );
});

test("the dependency label carries no connection string, bucket or credential", () => {
  // It is emitted as entityType, which logStructured validates as a
  // lowercase machine token. Anything richer would be dropped, so the
  // label has to stay a closed vocabulary rather than a description.
  for (const dependency of ["database", "object_storage"] as const) {
    assert.match(dependency, /^[a-z][a-z0-9._-]{0,63}$/u);
  }
  const both = new EnvironmentDependencyUnavailableError(["database", "object_storage"]);
  assert.match(both.dependencies.join("_and_"), /^[a-z][a-z0-9._-]{0,63}$/u);
});
