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
