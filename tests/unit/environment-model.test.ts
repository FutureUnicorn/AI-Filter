import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDestructiveEnvironmentAllowed,
  buildAlterRolePasswordStatement,
  buildDatabaseUrl,
  derivePreviewEnvironment,
  environmentIdentity,
  requireHostedControls,
  requireRotationControls
} from "../../scripts/environment/model.mjs";

const hostedControls = {
  AF11_ENABLE_HOSTED_ENVIRONMENTS: "true",
  COST_CONTROL_REFERENCE: "budget://signal-audit-production",
  COST_CONTROL_OWNER: "engineering-owner",
  ADMIN_AUDIT_REFERENCE: "audit://provider/production",
  ADMIN_ROLE_ALLOWLIST: "production-admin-role",
  POSTGRES_USER: "production-deployer",
  POSTGRES_PASSWORD: "a-production-secret-longer-than-twenty",
  STORAGE_ACCESS_KEY_ID: "production-storage-role",
  STORAGE_SECRET_ACCESS_KEY: "a-storage-secret-longer-than-twenty",
  PRODUCTION_VALIDATION_ONLY: "true"
};

test("preview identities are PR/SHA scoped and use distinct secrets", () => {
  const first = derivePreviewEnvironment("11", "a".repeat(40));
  const second = derivePreviewEnvironment("12", "b".repeat(40));
  assert.notEqual(first.project, second.project);
  assert.notEqual(first.variables.DATABASE_SCHEMA, second.variables.DATABASE_SCHEMA);
  assert.notEqual(first.variables.STORAGE_BUCKET, second.variables.STORAGE_BUCKET);
  assert.notEqual(first.variables.POSTGRES_PASSWORD, second.variables.POSTGRES_PASSWORD);
  assert.notDeepEqual(
    environmentIdentity("preview", first.variables),
    environmentIdentity("preview", second.variables)
  );
});

test("preview identity rejects unsafe identifiers", () => {
  assert.throws(() => derivePreviewEnvironment("0", "a".repeat(40)), /positive/u);
  assert.throws(() => derivePreviewEnvironment("12", "not-a-sha"), /commit SHA/u);
});

test("hosted deployment requires explicit controls and validation-only production", () => {
  assert.throws(() => requireHostedControls("staging", {}), /AF11_ENABLE/u);
  assert.doesNotThrow(() => requireHostedControls("staging", hostedControls));
  assert.doesNotThrow(() => requireHostedControls("production", hostedControls));
  assert.throws(
    () => requireHostedControls("production", { ...hostedControls, PRODUCTION_VALIDATION_ONLY: "false" }),
    /validation/u
  );
});

test("destructive resets cannot target persistent environments", () => {
  assert.throws(() => assertDestructiveEnvironmentAllowed("production", "reset"), /forbidden/u);
  assert.throws(() => assertDestructiveEnvironmentAllowed("staging", "reset"), /forbidden/u);
  assert.doesNotThrow(() => assertDestructiveEnvironmentAllowed("preview", "cleanup"));
});

test("database URLs percent-encode credentials so URI delimiters cannot corrupt or reparse them", () => {
  for (const password of ["p@ss", "pa/ss", "pa?ss", "pa#ss", "p a s s"]) {
    const url = buildDatabaseUrl({ user: "svc_user", password, database: "signal_audit_staging" });
    const parsed = new URL(url);
    assert.equal(decodeURIComponent(parsed.username), "svc_user");
    assert.equal(decodeURIComponent(parsed.password), password);
    assert.equal(parsed.hostname, "postgres");
    assert.equal(parsed.pathname, "/signal_audit_staging");
  }
});

test("preview environments derive a DATABASE_URL matching their own generated credentials", () => {
  const preview = derivePreviewEnvironment("42", "c".repeat(40));
  const parsed = new URL(preview.variables.DATABASE_URL);
  assert.equal(decodeURIComponent(parsed.username), preview.variables.POSTGRES_USER);
  assert.equal(decodeURIComponent(parsed.password), preview.variables.POSTGRES_PASSWORD);
});

test("rotation requires an outgoing password distinct from the incoming one", () => {
  const nextPassword = "a-new-production-secret-20";
  assert.throws(
    () => requireRotationControls({ POSTGRES_PASSWORD: nextPassword }),
    /POSTGRES_PASSWORD_PREVIOUS is required/u
  );
  assert.throws(
    () => requireRotationControls({ POSTGRES_PASSWORD: nextPassword, POSTGRES_PASSWORD_PREVIOUS: nextPassword }),
    /must differ/u
  );
  assert.throws(
    () => requireRotationControls({ POSTGRES_PASSWORD: "short", POSTGRES_PASSWORD_PREVIOUS: "also-short" }),
    /at least 20 characters/u
  );
  assert.deepEqual(
    requireRotationControls({ POSTGRES_PASSWORD: nextPassword, POSTGRES_PASSWORD_PREVIOUS: "an-old-production-secret-20" }),
    { previousPassword: "an-old-production-secret-20", nextPassword }
  );
});

test("the ALTER ROLE statement SQL-escapes the password and rejects unsafe identifiers", () => {
  assert.equal(
    buildAlterRolePasswordStatement("svc_user", "o'brien's-pass"),
    `ALTER ROLE "svc_user" WITH PASSWORD 'o''brien''s-pass';`
  );
  assert.throws(
    () => buildAlterRolePasswordStatement('bad user; DROP TABLE x; --', "x".repeat(20)),
    /safe PostgreSQL identifier/u
  );
});
