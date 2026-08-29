import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-51: "the model has no path to this endpoint."
//
// That clause is only meaningful if something checks it. The workspace
// dependency rule already forbids packages/ai -> packages/db, which is
// the structural half; these assert the parts that rule does not cover
// and that a future refactor could quietly undo.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readPackageSources(area: string): ReadonlyArray<readonly [string, string]> {
  const directory = join(repositoryRoot, area, "src");
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => [`${area}/src/${entry}`, readFileSync(join(directory, entry), "utf8")] as const);
}

test("the inference layer cannot name the decision recorder", () => {
  // Even a type-only import would mean the model layer knows this exists
  // and is one refactor away from calling it.
  for (const [path, source] of readPackageSources("packages/ai")) {
    for (const symbol of ["recordCandidateDecision", "candidate_decisions", "@signal-audit/db"]) {
      assert.ok(
        !source.includes(symbol),
        `${path} references ${symbol}; the model layer must have no path to a workflow decision`
      );
    }
  }
});

test("the decision recorder always requires a named human, with no defaulted actor", () => {
  const db = readFileSync(join(repositoryRoot, "packages/db/src/index.ts"), "utf8");
  const signature = db.slice(db.indexOf("interface RecordCandidateDecisionInput"));
  const body = signature.slice(0, signature.indexOf("}"));
  assert.ok(body.includes("readonly decidedByUserId: string;"), "decidedByUserId must be required");
  assert.ok(
    !body.includes("decidedByUserId?"),
    "an optional actor would let a caller record an unattributed decision"
  );
});

test("the decision endpoint takes its actor from the session, never from the request body", () => {
  const route = readFileSync(
    join(
      repositoryRoot,
      "apps/web/src/app/api/roles/[roleId]/applications/[applicationId]/decisions/route.ts"
    ),
    "utf8"
  );
  assert.ok(route.includes("readSessionUserId(request)"), "the actor must come from the session");
  assert.ok(
    route.includes("decidedByUserId: userId"),
    "the recorded actor must be the session user, not a value from the payload"
  );
  // A strictObject input schema is what turns "we ignore a decidedByUserId
  // in the body" into "we reject it", which is the difference between a
  // convention and a boundary.
  const contracts = readFileSync(join(repositoryRoot, "packages/contracts/src/index.ts"), "utf8");
  const schema = contracts.slice(contracts.indexOf("recordCandidateDecisionInputSchema"));
  const declaration = schema.slice(0, schema.indexOf("});"));
  assert.ok(declaration.includes("z.strictObject"), "the input schema must reject unknown fields");
  assert.ok(
    !declaration.includes("decidedByUserId"),
    "the input schema must offer no way to name a decider"
  );
});

test("no HTTP verb other than POST and GET exists on the decision endpoint", () => {
  // A PATCH or PUT would be a second way to change a status, and the
  // ticket's first clause is that there is only one.
  const route = readFileSync(
    join(
      repositoryRoot,
      "apps/web/src/app/api/roles/[roleId]/applications/[applicationId]/decisions/route.ts"
    ),
    "utf8"
  );
  const handlers = [...route.matchAll(/export async function ([A-Z]+)\(/gu)].map((match) => match[1]);
  assert.deepEqual([...handlers].sort(), ["GET", "POST"]);
});
