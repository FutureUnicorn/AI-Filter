import assert from "node:assert/strict";
import test from "node:test";

import { requireBackupControls } from "../../scripts/backups/model.mjs";

const approvedControls = {
  BACKUP_ENABLED: "true",
  BACKUP_ENDPOINT: "https://backups.example.test",
  BACKUP_REGION: "ap-south-1",
  BACKUP_BUCKET: "signal-audit-staging-backups",
  BACKUP_ACCESS_KEY_ID: "staging-backup-writer",
  BACKUP_SECRET_ACCESS_KEY: "a-backup-secret-longer-than-twenty",
  BACKUP_INTERVAL_SECONDS: "86400",
  BACKUP_RETENTION_DAYS: "30",
  BACKUP_PATH_STYLE: "off",
  BACKUP_CONTROL_OWNER: "platform-operations",
  BACKUP_ENCRYPTION_REFERENCE: "kms://backup-provider/staging"
};

test("non-hosted environments never enable hosted backups", () => {
  assert.deepEqual(requireBackupControls("development", approvedControls), {
    enabled: false,
    variables: {}
  });
  assert.deepEqual(requireBackupControls("preview", approvedControls), {
    enabled: false,
    variables: {}
  });
});

test("hosted backups remain disabled without external approval", () => {
  assert.deepEqual(requireBackupControls("staging", {}), {
    enabled: false,
    variables: { BACKUP_ENABLED: "false" }
  });
  assert.deepEqual(requireBackupControls("production", { BACKUP_ENABLED: "false" }), {
    enabled: false,
    variables: { BACKUP_ENABLED: "false" }
  });
});

test("enabled hosted backups return only validated normalized controls", () => {
  const result = requireBackupControls("staging", {
    ...approvedControls,
    BACKUP_ENDPOINT: "https://backups.example.test/"
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.variables, {
    ...approvedControls,
    BACKUP_ENDPOINT: "https://backups.example.test"
  });
});

test("hosted backup enablement is a strict boolean", () => {
  assert.throws(
    () => requireBackupControls("production", { BACKUP_ENABLED: "yes" }),
    /BACKUP_ENABLED must be true or false/u
  );
});

test("enabled backups require every operational decision", () => {
  for (const name of [
    "BACKUP_ENDPOINT",
    "BACKUP_REGION",
    "BACKUP_BUCKET",
    "BACKUP_ACCESS_KEY_ID",
    "BACKUP_SECRET_ACCESS_KEY",
    "BACKUP_INTERVAL_SECONDS",
    "BACKUP_RETENTION_DAYS",
    "BACKUP_CONTROL_OWNER",
    "BACKUP_ENCRYPTION_REFERENCE"
  ]) {
    const source = { ...approvedControls };
    delete source[name as keyof typeof source];
    assert.throws(
      () => requireBackupControls("staging", source),
      new RegExp(name, "u"),
      name
    );
  }
});

test("backup destination must be a credential-free HTTPS origin", () => {
  for (const endpoint of [
    "http://backups.example.test",
    "https://writer:secret@backups.example.test",
    "https://backups.example.test/private",
    "https://backups.example.test?token=secret",
    "not-a-url"
  ]) {
    assert.throws(
      () => requireBackupControls("production", { ...approvedControls, BACKUP_ENDPOINT: endpoint }),
      /BACKUP_ENDPOINT/u,
      endpoint
    );
  }
});

test("backup target identifiers and timing values are bounded to safe syntax", () => {
  assert.throws(
    () => requireBackupControls("staging", { ...approvedControls, BACKUP_BUCKET: "../escape" }),
    /BACKUP_BUCKET/u
  );
  assert.throws(
    () => requireBackupControls("staging", { ...approvedControls, BACKUP_REGION: "region; echo secret" }),
    /BACKUP_REGION/u
  );
  assert.throws(
    () => requireBackupControls("staging", { ...approvedControls, BACKUP_PATH_STYLE: "sometimes" }),
    /BACKUP_PATH_STYLE/u
  );
  for (const value of ["0", "-1", "1.5", "030", "forever"]) {
    assert.throws(
      () => requireBackupControls("staging", { ...approvedControls, BACKUP_INTERVAL_SECONDS: value }),
      /BACKUP_INTERVAL_SECONDS/u
    );
    assert.throws(
      () => requireBackupControls("staging", { ...approvedControls, BACKUP_RETENTION_DAYS: value }),
      /BACKUP_RETENTION_DAYS/u
    );
  }
});

test("backup credentials are required but never included in validation errors", () => {
  const secret = "short";
  assert.throws(
    () => requireBackupControls("staging", { ...approvedControls, BACKUP_SECRET_ACCESS_KEY: secret }),
    (error: unknown) =>
      error instanceof Error &&
      /BACKUP_SECRET_ACCESS_KEY/u.test(error.message) &&
      !error.message.includes(secret)
  );
});
