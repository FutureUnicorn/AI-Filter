import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
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

// ---- AF-103, the emission itself ----
//
// PR #94 review, REV-003 (Saikrishnaa-vr). The two tests above assert that
// EnvironmentDependencyUnavailableError carries the right dependencies and
// that the label is a safe token. Neither runs the health failure path, so
// neither observes what logStructured actually receives. Deleting the whole
// `entityType` emission from createWorkerHealthServer leaves both green,
// measured before writing this: 6 passed, 0 failed, with the feature gone.
//
// That is the exact shape the ticket is about. The runbook excuses
// /health/environment from the Sentry error detectors on the grounds that
// failures "remain visible through the structured *.environment_health_failed
// log events", and the value of that excuse is entirely in whether the log
// names the dependency. A test that builds the error object and inspects it
// tests the error object. This drives a real request through the real health
// server and reads the line that came out.
//
// Both dependencies are probed concurrently, so staging one failure at a time
// means a real endpoint for the other. CI has Postgres and no object store,
// so the storage side is stood up here as a plain HTTP server answering the
// HeadBucket probe. The boundary is stubbed; the typed errors, the smoke
// check, the handler and the logger are all the shipped ones.

function requireWorkerDatabase(): string {
  const value = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];
  if (value === undefined || value === "") {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set. See README.md.");
  }
  return value;
}

/** An endpoint that answers HeadBucket, so "storage is up" is stageable without MinIO. */
async function reachableStorage(): Promise<{ readonly endpoint: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      })
  };
}

/** A port with nothing behind it, so a probe fails by connection refusal rather than by timeout. */
async function unreachablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function closeHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

const HEALTH_CASES = [
  { label: "a database-only failure", database: "down", storage: "up", entityType: "database" },
  { label: "a storage-only failure", database: "up", storage: "down", entityType: "object_storage" },
  {
    label: "both dependencies down",
    database: "down",
    storage: "down",
    entityType: "database_and_object_storage"
  }
] as const;

for (const scenario of HEALTH_CASES) {
  test(`${scenario.label} names the dependency in the health failure log`, async (t) => {
    const storage = await reachableStorage();
    const deadPort = await unreachablePort();
    t.after(async () => {
      await storage.close();
    });

    const source = {
      APP_ENV: "development",
      DEPLOYMENT_COMMIT_SHA: "local",
      DATABASE_URL:
        scenario.database === "up"
          ? requireWorkerDatabase()
          : `postgresql://unreachable:unreachable@127.0.0.1:${deadPort}/signal_audit_absent`,
      DATABASE_SCHEMA: "public",
      STORAGE_ENDPOINT: scenario.storage === "up" ? storage.endpoint : `http://127.0.0.1:${deadPort}`,
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "signal-audit-development",
      STORAGE_ACCESS_KEY_ID: "local-access",
      STORAGE_SECRET_ACCESS_KEY: "local-secret-value",
      STORAGE_FORCE_PATH_STYLE: "true",
      WEB_PORT: "3000",
      WORKER_PORT: "3001"
    };

    const errorLog = t.mock.method(console, "error", () => undefined);
    const server = createWorkerHealthServer(source);
    t.after(async () => {
      await closeHealthServer(server);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/health/environment`);

    // The response stays deliberately uninformative; the diagnosis lives in
    // the log, which is the whole premise the runbook's exclusion rests on.
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });

    const entry = findHealthFailureLog(errorLog.mock.calls, "worker.environment_health_failed");
    const context = entry.context as Record<string, unknown>;
    assert.equal(
      context["entityType"],
      scenario.entityType,
      `the log must name which dependency failed; got ${JSON.stringify(context)}`
    );
    assert.equal(context["errorName"], "EnvironmentDependencyUnavailableError");
    assert.equal(context["statusCode"], 503);

    // The label is the only new thing on the line. A connection string, a
    // bucket name or a credential riding along would turn an operator aid
    // into a leak.
    assert.doesNotMatch(
      JSON.stringify(entry),
      /unreachable|signal-audit-development|local-secret-value|127\.0\.0\.1/u
    );
  });
}

test("a healthy worker logs no failure at all", async (t) => {
  // The control for the three above: if every run produced a failure line,
  // asserting its contents would prove nothing about when it is written.
  const storage = await reachableStorage();
  t.after(async () => {
    await storage.close();
  });
  const errorLog = t.mock.method(console, "error", () => undefined);
  const server = createWorkerHealthServer({
    APP_ENV: "development",
    DEPLOYMENT_COMMIT_SHA: "local",
    DATABASE_URL: requireWorkerDatabase(),
    DATABASE_SCHEMA: "public",
    STORAGE_ENDPOINT: storage.endpoint,
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-development",
    STORAGE_ACCESS_KEY_ID: "local-access",
    STORAGE_SECRET_ACCESS_KEY: "local-secret-value",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001"
  });
  t.after(async () => {
    await closeHealthServer(server);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/health/environment`);
  assert.equal(response.status, 200);
  assert.equal(
    errorLog.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.includes("worker.environment_health_failed")).length,
    0,
    "a healthy environment must write no health failure line"
  );
});
