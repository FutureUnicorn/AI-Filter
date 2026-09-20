import process from "node:process";

import { loadEnvironmentConfig } from "../../packages/config/dist/index.js";
import { bootstrapOrganizationOwner, closeDatabasePools } from "../../packages/db/dist/index.js";

/**
 * AF-97: create the first organization, user and owner membership of a
 * deployment.
 *
 * This is the one privilege grant in the system that cannot come from
 * inside the product, because authentication is invite-only and the first
 * invite has nobody to come from. It is a command rather than an HTTP
 * route on purpose: an unauthenticated route that mints an owner would
 * have to be disabled after first use, and "we remembered to disable it"
 * is not a security control. Running this requires the database
 * credentials the deployment already protects.
 *
 * Unlike `pnpm db:seed`, this is not a synthetic fixture and is not
 * refused in production -- a production deployment is precisely where
 * somebody has to be the first owner. It writes only the three rows it
 * names, and re-running it converges rather than duplicating.
 *
 *   pnpm bootstrap:owner --organization "Acme" --email owner@acme.test --name "Dana Ops"
 */

/*
 * `.env.local` is loaded by the pnpm script's `--env-file-if-exists`, not
 * by `process.loadEnvFile` as dev.mjs does: that flag leaves an already-set
 * variable alone, while loadEnvFile overwrites it. This command is the one
 * here that legitimately runs against a hosted deployment, where a stale
 * local file silently winning over the real DATABASE_URL would point an
 * ownership grant at the wrong database.
 */

const USAGE =
  "Usage: pnpm bootstrap:owner --organization <name> --email <address> --name <display name>";

/** Long-form flags only: this grants ownership of a tenant, and `-o` next
 * to `-e` is the kind of thing that is easy to transpose and impossible to
 * notice in shell history. */
function parseArguments(argv) {
  const flags = new Map([
    ["--organization", "organizationName"],
    ["--email", "email"],
    ["--name", "displayName"]
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = flags.get(argv[index]);
    const value = argv[index + 1];
    if (field === undefined) {
      throw new Error(`Unrecognized argument ${JSON.stringify(argv[index])}. ${USAGE}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argv[index]} requires a value. ${USAGE}`);
    }
    if (parsed[field] !== undefined) {
      throw new Error(`${argv[index]} was given twice. ${USAGE}`);
    }
    parsed[field] = value;
  }
  for (const field of ["organizationName", "email", "displayName"]) {
    if (parsed[field] === undefined) {
      throw new Error(`Missing required argument. ${USAGE}`);
    }
  }
  return parsed;
}

/**
 * A mistyped flag is an operator error, not a crash: it gets the reason and
 * the usage line on stderr, and a non-zero exit, rather than a Node stack
 * trace whose first useful line is thirty characters in.
 *
 * Deliberately only around argument parsing and configuration. A failure
 * from the database itself keeps its stack, because there the stack is the
 * diagnostic.
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

let input;
let config;
try {
  input = parseArguments(process.argv.slice(2));
  // Requires the same environment every other service here validates at
  // startup, including the storage variables this command never reads. That
  // is the point: it runs inside the deployment it is granting ownership of,
  // so a run that cannot load that deployment's configuration is a run
  // pointed somewhere unintended.
  config = loadEnvironmentConfig(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

try {
  const result = await bootstrapOrganizationOwner(config.database.url, config.database.schema, input);
  // The email is the operator's own input, echoed back to the terminal they
  // typed it into, so this is not the retained log stream AF-21 governs --
  // and an operator who cannot see which address was granted ownership
  // cannot check their own work.
  console.log(
    JSON.stringify(
      {
        status: "ok",
        organizationId: result.organizationId,
        userId: result.userId,
        organizationCreated: result.organizationCreated,
        userCreated: result.userCreated,
        membership: result.membership,
        signInAt: `${config.publicAppOrigin}/`
      },
      undefined,
      2
    )
  );
  if (!result.organizationCreated) {
    console.error(
      `Note: an organization named ${JSON.stringify(input.organizationName)} already existed and was reused.`
    );
  }
  if (result.membership === "promoted") {
    console.error(`Note: ${input.email} already belonged to this organization and was promoted to owner.`);
  }
} finally {
  // allowExitOnIdle already lets the process exit, but a bootstrap that
  // returns before its connections are gone is a bad example to copy into
  // a deployment script that does more afterwards.
  await closeDatabasePools();
}
