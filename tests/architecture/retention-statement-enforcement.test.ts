import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// REV-005. summarizeSurvivingCandidateData writes the sentence a privacy
// notice tells a data subject about their own data. Whether it may say
// "is deleted" turns on RetentionEnforcement.automatedDeletionActive, and
// the design rests on that value being REQUIRED: a false statement should
// need someone to pass a false value, never merely to forget one.
//
// Only tsc enforces "required", and the tests in this repository run
// through node --test with strip-types, which does not type-check them.
// So a later `= { automatedDeletionActive: true }` default would restore
// the optimistic sentence by omission and every behavioural test would
// keep passing. These assertions read the source instead. Deliberately a
// targeted regex over located regions, not a TypeScript parser: the
// property is small and so is the check.
//
// No exemption list: there is no legitimate caller that needs a default.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const domain = readFileSync(join(repositoryRoot, "packages/domain/src/index.ts"), "utf8");

function region(startMarker: string, endMarker: string): string {
  const start = domain.indexOf(startMarker);
  assert.ok(start >= 0, `could not locate ${JSON.stringify(startMarker)} in packages/domain/src/index.ts`);
  const end = domain.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not locate the end of ${JSON.stringify(startMarker)}`);
  return domain.slice(start, end + endMarker.length);
}

test("summarizeSurvivingCandidateData is declared once, so no overload can drop the flag", () => {
  // An overload taking only the plan would make the flag optional to
  // callers without touching the implementation's signature.
  assert.equal(
    domain.split("function summarizeSurvivingCandidateData").length - 1,
    1,
    "exactly one declaration: an overload is a second, possibly flagless, signature"
  );
});

test("the enforcement parameter is required: no ? marker and no default", () => {
  const signature = region("export function summarizeSurvivingCandidateData(", "): SurvivingCandidateData {");
  const parameters = signature
    .slice(signature.indexOf("(") + 1, signature.lastIndexOf("):"))
    .split(",")
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter.length > 0);
  assert.equal(parameters.length, 2, `expected (plan, enforcement), found: ${parameters.join(" | ")}`);
  assert.match(
    parameters[1] ?? "",
    /^[A-Za-z_]\w*\s*:\s*RetentionEnforcement$/u,
    "the second parameter must be a plain required RetentionEnforcement: no `?`, no `=` default, no union"
  );
});

test("the body does not reintroduce a default the signature refuses", () => {
  // The same omission, moved one line down: a destructuring default, a
  // nullish fallback, or optional chaining on the argument.
  const body = region("): SurvivingCandidateData {", "\n}\n");
  assert.doesNotMatch(body, /automatedDeletionActive\s*=(?!=)/u, "no destructuring default for the flag");
  assert.doesNotMatch(body, /automatedDeletionActive\s*\?\?/u, "no nullish fallback for the flag");
  assert.doesNotMatch(body, /enforcement\s*\?\./u, "the argument is required, so it is never optional-chained");
});

test("RetentionEnforcement.automatedDeletionActive is a required boolean", () => {
  assert.equal(
    domain.split("export interface RetentionEnforcement").length - 1,
    1,
    "RetentionEnforcement must be declared once, as the interface this guard reads"
  );
  const declaration = region("export interface RetentionEnforcement {", "\n}\n");
  assert.match(
    declaration,
    /readonly automatedDeletionActive: boolean;/u,
    "the flag must be declared as a plain required boolean"
  );
  assert.doesNotMatch(declaration, /automatedDeletionActive\s*\?/u, "the flag must not be optional");
  assert.doesNotMatch(declaration, /automatedDeletionActive:[^;]*undefined/u, "the flag must not admit undefined");
});
