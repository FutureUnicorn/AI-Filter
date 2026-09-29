import assert from "node:assert/strict";
import test from "node:test";

import { requireBackupControls } from "../../scripts/backups/model.mjs";
import { deployEnvironment } from "../../scripts/environment/cli.mjs";

const approvedControls = {
  BACKUP_ENABLED: "true",
  BACKUP_ENDPOINT: "https://backups.example.test",
  BACKUP_REGION: "ap-south-1",
  BACKUP_BUCKET: "signal-audit-staging-backups",
  BACKUP_ADMIN_ACCESS_KEY_ID: "staging-backup-admin",
  BACKUP_ADMIN_SECRET_ACCESS_KEY: "an-admin-secret-longer-than-twenty",
  BACKUP_WRITER_ACCESS_KEY_ID: "staging-backup-writer",
  BACKUP_WRITER_SECRET_ACCESS_KEY: "a-writer-secret-longer-than-twenty",
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
    "BACKUP_ADMIN_ACCESS_KEY_ID",
    "BACKUP_ADMIN_SECRET_ACCESS_KEY",
    "BACKUP_WRITER_ACCESS_KEY_ID",
    "BACKUP_WRITER_SECRET_ACCESS_KEY",
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
  for (const name of ["BACKUP_ADMIN_SECRET_ACCESS_KEY", "BACKUP_WRITER_SECRET_ACCESS_KEY"] as const) {
    assert.throws(
      () => requireBackupControls("staging", { ...approvedControls, [name]: secret }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(name) &&
        !error.message.includes(secret)
    );
  }
});

test("a disabled hosted deploy removes a previously enabled backup before continuing", () => {
  const calls: Array<{
    readonly project: string;
    readonly variables: Readonly<Record<string, string>>;
    readonly arguments_: readonly string[];
    readonly local: boolean;
  }> = [];
  deployEnvironment(
    {
      project: "signal-audit-staging",
      backupEnabled: false,
      variables: { APP_ENV: "staging", BACKUP_ENABLED: "false" }
    },
    false,
    (
      project: string,
      variables: Readonly<Record<string, string>>,
      arguments_: readonly string[],
      local = false
    ) => {
      calls.push({ project, variables, arguments_, local });
    }
  );

  assert.deepEqual(calls[0]?.arguments_, [
    "--profile",
    "backups",
    "rm",
    "--stop",
    "--force",
    "backup"
  ]);
  assert.deepEqual(calls.at(-1)?.arguments_, ["up", "-d", "--build", "web", "worker"]);
  assert.ok(
    calls.findIndex(({ arguments_ }) => arguments_[0] === "rm") <
      calls.findIndex(({ arguments_ }) => arguments_[0] === "up" && arguments_.includes("postgres")),
    "off-host backup activity must stop before deployment prerequisites run"
  );
});
