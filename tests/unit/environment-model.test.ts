import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDestructiveEnvironmentAllowed,
  derivePreviewEnvironment,
  environmentIdentity,
  requireHostedControls
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
