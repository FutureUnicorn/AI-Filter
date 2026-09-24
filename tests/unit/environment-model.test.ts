import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDestructiveEnvironmentAllowed,
  buildAlterRolePasswordStatement,
  buildDatabaseUrl,
  buildRotationCommand,
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
  for (const password of ["p@ss", "pa/ss", "pa?ss", "pa#ss", "p a s s", "pa%ss", "pa:ss"]) {
    const url = buildDatabaseUrl({ user: "svc_user", password, database: "signal_audit_staging" });
    const parsed = new URL(url);

    // Asserted against the encoded form, not just the round-trip (#86,
    // REV-006): `decodeURIComponent(parsed.password) === password` also
    // holds for the unencoded string when the password contains `@`,
    // because URL parsing splits userinfo at the *last* `@`. That is the
    // case this change leads with, so it is the one worth pinning.
    assert.equal(parsed.password, encodeURIComponent(password));
    assert.equal(parsed.username, encodeURIComponent("svc_user"));
    assert.equal(decodeURIComponent(parsed.password), password);
    assert.equal(parsed.hostname, "postgres");
    assert.equal(parsed.pathname, "/signal_audit_staging");
  }
});

test("the rotation command reaches the database where the password is actually checked", () => {
  const command = buildRotationCommand({
    image: "postgres:17.10-alpine3.23",
    network: "signal-audit-staging_private",
    user: "svc_user",
    database: "signal_audit_staging"
  });

  // The property REV-001 broke. The official image's pg_hba.conf carries
  // initdb's `host all all 127.0.0.1/32 trust` *before* the entrypoint's
  // appended `host all all all scram-sha-256`, and the file is
  // first-match-wins, so anything reaching Postgres over loopback is
  // trusted and PGPASSWORD is never verified. Connecting from a separate
  // container on the environment's private network is what makes the
  // outgoing password load-bearing, so assert the address, not a comment.
  assert.equal(command[command.indexOf("--host") + 1], "postgres");
  assert.ok(!command.includes("127.0.0.1"), "a loopback connection would skip password authentication");
  assert.equal(command[command.indexOf("--network") + 1], "signal-audit-staging_private");
  assert.equal(command[command.indexOf("--username") + 1], "svc_user");
  assert.equal(command[command.indexOf("--dbname") + 1], "signal_audit_staging");
});

test("the rotation command carries no password in its argv", () => {
  const command = buildRotationCommand({
    image: "postgres:17.10-alpine3.23",
    network: "signal-audit-staging_private",
    user: "svc_user",
    database: "signal_audit_staging"
  });

  // Forwarded by name so Docker reads the value from the calling process's
  // environment; a `PGPASSWORD=<secret>` argument would put it in `ps`.
  assert.ok(command.includes("PGPASSWORD"));
  assert.ok(
    !command.some((argument) => argument.startsWith("PGPASSWORD=")),
    "PGPASSWORD must be forwarded by name, never as a flag value"
  );
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
