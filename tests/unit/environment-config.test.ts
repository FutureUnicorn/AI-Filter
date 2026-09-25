import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDestructiveOperationAllowed,
  assertEnvironmentIsolation,
  assertSyntheticDataAllowed,
  loadEnvironmentConfig,
  loadEvidenceExtractionQueueConfig,
  loadMonitoringConfig,
  loadWorkerProcessingConfig,
  publicEnvironmentSummary,
  type EnvironmentSource
} from "../../packages/config/src/index.ts";

function validEnvironment(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    APP_ENV: "development",
    DEPLOYMENT_COMMIT_SHA: "local",
    DATABASE_URL: "postgresql://local:local@localhost:5432/local",
    DATABASE_SCHEMA: "public",
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-development",
    STORAGE_ACCESS_KEY_ID: "local-access",
    STORAGE_SECRET_ACCESS_KEY: "local-secret-value",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    ...overrides
  };
}

test("environment configuration is explicit, typed, and server-only", () => {
  const config = loadEnvironmentConfig(validEnvironment());
  assert.equal(config.appEnv, "development");
  assert.equal(config.storage.forcePathStyle, true);
  assert.deepEqual(publicEnvironmentSummary(config), {
    appEnv: "development",
    deploymentCommitSha: "local"
  });
  assert.equal(JSON.stringify(publicEnvironmentSummary(config)).includes("local-secret"), false);
});

test("missing private configuration fails before runtime work begins", () => {
  assert.throws(
    () => loadEnvironmentConfig(validEnvironment({ DATABASE_URL: undefined })),
    /DATABASE_URL/u
  );
});

test("preview identity must match its deployed commit", () => {
  assert.throws(
    () =>
      loadEnvironmentConfig(
        validEnvironment({
          APP_ENV: "preview",
          DEPLOYMENT_COMMIT_SHA: "aaaaaaaaaaaaaaaa",
          PREVIEW_ID: "pr-12",
          PREVIEW_COMMIT_SHA: "bbbbbbb"
        })
      ),
    /preview deployment must identify the preview commit/u
  );
});

test("destructive and synthetic commands fail closed for production", () => {
  assert.throws(() => assertDestructiveOperationAllowed("production", "reset"), /forbidden/u);
  assert.throws(() => assertDestructiveOperationAllowed("staging", "reset"), /forbidden/u);
  assert.throws(() => assertSyntheticDataAllowed("production"), /never be seeded/u);
  assert.doesNotThrow(() => assertSyntheticDataAllowed("staging"));
});

test("database, storage, and credential boundaries cannot be shared", () => {
  assert.throws(
    () =>
      assertEnvironmentIsolation([
        {
          name: "staging",
          databaseBoundary: "postgres/staging",
          storageBoundary: "staging-bucket",
          credentialIdentity: "staging-role"
        },
        {
          name: "production",
          databaseBoundary: "postgres/production",
          storageBoundary: "production-bucket",
          credentialIdentity: "staging-role"
        }
      ]),
    /credentialIdentity is shared/u
  );
});

// Review (#28), P1. An earlier revision required the magic-link delivery
// settings only for staging and production, so a preview deployment with
// none of them loaded cleanly and then fell through to the console sender:
// the raw recipient address and bearer link written to the stderr of a
// hosted process, and no link delivered to the preview user. Preview is a
// per-PR/per-SHA deployment here -- it derives its own database schema --
// not a developer terminal.
test("a hosted environment without magic-link delivery settings is refused at config load", () => {
  for (const appEnv of ["preview", "staging", "production"] as const) {
    const overrides: EnvironmentSource =
      appEnv === "preview"
        ? {
            APP_ENV: appEnv,
            PREVIEW_ID: "pr-1",
            PREVIEW_COMMIT_SHA: "abc1234",
            DEPLOYMENT_COMMIT_SHA: "abc1234"
          }
        : { APP_ENV: appEnv };
    let message = "";
    try {
      loadEnvironmentConfig(validEnvironment(overrides));
      assert.fail(`${appEnv} without delivery settings must not load`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Every missing variable is named, so the operator fixes the deployment
    // in one pass instead of rediscovering them one restart at a time.
    for (const field of [
      "MAGIC_LINK_EMAIL_ENDPOINT",
      "MAGIC_LINK_EMAIL_API_KEY",
      "MAGIC_LINK_EMAIL_FROM"
    ]) {
      assert.ok(message.includes(field), `${appEnv} error should name ${field}, got: ${message}`);
    }
  }
});

test("a hosted environment with delivery settings loads and exposes them", () => {
  const config = loadEnvironmentConfig(
    validEnvironment({
      APP_ENV: "preview",
      PREVIEW_ID: "pr-1",
      PREVIEW_COMMIT_SHA: "abc1234",
      // preview additionally pins the deployed commit to the preview commit.
      DEPLOYMENT_COMMIT_SHA: "abc1234",
      MAGIC_LINK_EMAIL_ENDPOINT: "https://mail.test/send",
      MAGIC_LINK_EMAIL_API_KEY: "preview-key",
      MAGIC_LINK_EMAIL_FROM: "no-reply@acme.test",
      // Also required for every hosted environment as of review #83: emailed
      // links must come from a configured origin, never the request host.
      PUBLIC_APP_ORIGIN: "https://pr-1.preview.acme.test"
    })
  );
  assert.equal(config.publicAppOrigin, "https://pr-1.preview.acme.test");
  assert.deepEqual(config.magicLinkEmail, {
    endpoint: "https://mail.test/send",
    apiKey: "preview-key",
    from: "no-reply@acme.test"
  });
  // The secret must not reach the summary that gets logged.
  assert.equal(JSON.stringify(publicEnvironmentSummary(config)).includes("preview-key"), false);
});

test("development and test still load without delivery settings, so local sign-in stays completable", () => {
  for (const appEnv of ["development", "test"] as const) {
    assert.doesNotThrow(() => loadEnvironmentConfig(validEnvironment({ APP_ENV: appEnv })));
  }
});

test("local monitoring is disabled without a Sentry account and keeps stable service identity", () => {
  assert.deepEqual(loadMonitoringConfig(validEnvironment(), "web"), {
    enabled: false,
    service: "web",
    environment: "development",
    release: "local"
  });
});

test("hosted monitoring fails closed when its service DSN is absent", () => {
  for (const appEnv of ["preview", "staging", "production"] as const) {
    assert.throws(
      () => loadMonitoringConfig(validEnvironment({ APP_ENV: appEnv }), "worker"),
      /SENTRY_DSN is required/u
    );
  }
});

test("monitoring derives environment and release and requires an explicit valid sample rate", () => {
  const source = validEnvironment({
    APP_ENV: "staging",
    DEPLOYMENT_COMMIT_SHA: "abc1234",
    SENTRY_DSN: "https://public-key@sentry.example/123",
    SENTRY_TRACES_SAMPLE_RATE: "0.25"
  });
  assert.deepEqual(loadMonitoringConfig(source, "worker"), {
    enabled: true,
    service: "worker",
    environment: "staging",
    release: "abc1234",
    dsn: "https://public-key@sentry.example/123",
    tracesSampleRate: 0.25
  });
  for (const rate of [undefined, "-0.1", "1.1", "not-a-number"]) {
    assert.throws(
      () => loadMonitoringConfig({ ...source, SENTRY_TRACES_SAMPLE_RATE: rate }, "worker"),
      /SENTRY_TRACES_SAMPLE_RATE/u
    );
  }
});

test("worker processing is credential-free while disabled and validates hosted processing when enabled", () => {
  assert.deepEqual(loadWorkerProcessingConfig({}), {
    enabled: false,
    concurrency: 1,
    pollIntervalMs: 1_000,
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 60_000,
    retryBaseDelayMs: 5_000,
    maxAttempts: 3
  });
  assert.equal(loadWorkerProcessingConfig({ WORKER_CONCURRENCY: "16" }).concurrency, 16);
  assert.throws(
    () => loadWorkerProcessingConfig({ WORKER_CONCURRENCY: "17" }),
    /WORKER_CONCURRENCY.*16/u
  );
  const enabled = loadWorkerProcessingConfig({
    WORKER_PROCESSING_ENABLED: "true",
    WORKER_INSTANCE_ID: "worker-staging-1",
    OPENAI_API_KEY: "synthetic-key",
    OPENAI_MODEL: "default-model",
    OPENAI_ESCALATION_MODEL: "escalation-model",
    INFERENCE_MAX_TOKENS_PER_PERIOD: "100000",
    INFERENCE_ALERT_THRESHOLD_RATIO: "0.8",
    INFERENCE_BUDGET_PERIOD: "month",
    WORKER_CONCURRENCY: "4"
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.workerId, "worker-staging-1");
  assert.equal(enabled.concurrency, 4);
  assert.equal(enabled.budget?.maxTokensPerPeriod, 100_000);
  assert.equal(enabled.budget?.period, "month");
  assert.equal(JSON.stringify(enabled).includes("candidate"), false);
  assert.throws(
    () => loadWorkerProcessingConfig({ WORKER_PROCESSING_ENABLED: "true" }),
    /WORKER_INSTANCE_ID.*OPENAI_API_KEY.*OPENAI_MODEL.*OPENAI_ESCALATION_MODEL.*INFERENCE_MAX_TOKENS_PER_PERIOD/u
  );
  assert.throws(
    () =>
      loadWorkerProcessingConfig({
        WORKER_PROCESSING_ENABLED: "true",
        WORKER_INSTANCE_ID: "worker-1",
        OPENAI_API_KEY: "synthetic-key",
        OPENAI_MODEL: "default",
        OPENAI_ESCALATION_MODEL: "escalation",
        INFERENCE_MAX_TOKENS_PER_PERIOD: "1000",
        INFERENCE_ALERT_THRESHOLD_RATIO: "0.8",
        INFERENCE_BUDGET_PERIOD: "day",
        WORKER_HEARTBEAT_INTERVAL_MS: "30000",
        WORKER_LEASE_DURATION_MS: "60000"
      }),
    /less than half/u
  );
});

test("web enqueue and worker use the same bounded retry count", () => {
  assert.deepEqual(loadEvidenceExtractionQueueConfig({}), { maxAttempts: 3 });
  assert.deepEqual(loadEvidenceExtractionQueueConfig({ WORKER_MAX_ATTEMPTS: "5" }), { maxAttempts: 5 });
  assert.throws(
    () => loadEvidenceExtractionQueueConfig({ WORKER_MAX_ATTEMPTS: "0" }),
    /positive integer/u
  );
});
