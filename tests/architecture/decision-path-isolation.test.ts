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
//
// AF-100 moved two assertions out of this file, because a real request
// answers them better than a source-text match can:
//
//   * "the endpoint takes its actor from the session, never from the request
//     body" matched the strings `readSessionUserId(request)` and
//     `decidedByUserId: userId`. Both survive in a handler that reads the
//     session and then prefers an `x-acting-user` header -- confirmed by
//     writing that handler and watching this file stay green.
//   * the verb inventory was a regex over `export async function ([A-Z]+)(`,
//     which counts a match inside a comment or a string.
//
// Both now live in tests/integration/api-route-harness.test.ts, which signs a
// request as one member, supplies another member's id down every channel a
// handler could read, and checks the row. What stays here is what no request
// can reach: whether another layer can name the recorder at all.

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

test("the input contract offers no way to name a decider", () => {
  // The other half of "the actor comes from the session" is that a body
  // field naming one is rejected rather than ignored -- the difference
  // between a convention and a boundary. That rejection is exercised as a
  // 400 in api-route-harness.test.ts; what is checked here is the property
  // no single request can show, that the schema admits no such field under
  // any name the endpoint would accept.
  const contracts = readFileSync(join(repositoryRoot, "packages/contracts/src/index.ts"), "utf8");
  const schema = contracts.slice(contracts.indexOf("recordCandidateDecisionInputSchema"));
  const declaration = schema.slice(0, schema.indexOf("});"));
  assert.ok(declaration.includes("z.strictObject"), "the input schema must reject unknown fields");
  assert.ok(
    !declaration.includes("decidedByUserId"),
    "the input schema must offer no way to name a decider"
  );
});

// Merging develop (2026-09-25): an unrelated replay commit (3f20ce7,
// predating this PR) had reintroduced the old regex-based verb check this
// file already explains removing above, and AF-67 (e7ef653) then had to
// widen that regex to also match `export const X = ...` once the decisions
// route started wrapping its handlers in withServerOperation. That edit is
// itself the failure mode described above, arriving on schedule: the guard
// had to be patched by hand to keep matching source text that changed shape
// without changing behavior. Resolved by keeping this file's converted form;
// the verb inventory stays in api-route-harness.test.ts's loadRouteMethods
// check, which reads the loaded module's real exports and does not care
// whether a handler is `export async function` or `export const ... =`.
