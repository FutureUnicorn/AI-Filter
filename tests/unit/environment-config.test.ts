import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDestructiveOperationAllowed,
  assertEnvironmentIsolation,
  assertSyntheticDataAllowed,
  loadEnvironmentConfig,
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
      MAGIC_LINK_EMAIL_FROM: "no-reply@acme.test"
    })
  );
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
