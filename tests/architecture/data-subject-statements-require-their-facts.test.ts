import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// REV-008 (#76), generalising #70 REV-005. Some functions write a sentence
// that is shown to a data subject about their own data, and the sentence is
// only true if the caller tells the function what actually happened. Every
// such function must REQUIRE that fact: with a default, the optimistic
// sentence is reached by forgetting an argument, and every behavioural test
// keeps passing because they all pass it explicitly. tsc is the only other
// thing that would notice, and the tests in this repository are not
// type-checked, so this reads the source.
//
// Table-driven so each statement function is one row. #70 REV-005 added the
// same rule for summarizeSurvivingCandidateData in
// tests/architecture/retention-statement-enforcement.test.ts on
// feature/AF-61-retention-policy, which this branch does not yet contain.
// When the two branches meet, fold that guard into a row here rather than
// keeping two.
//
// No exemption list: no statement function has a legitimate default.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const domain = readFileSync(join(repositoryRoot, "packages/domain/src/index.ts"), "utf8");

interface StatementFunction {
  readonly name: string;
  readonly returns: string;
  /** Zero-based position of the parameter that carries the facts. */
  readonly factsParameter: number;
  readonly factsType: string;
  /** Every field of the facts type, each of which must be required. */
  readonly factsFields: readonly string[];
}

const STATEMENT_FUNCTIONS: readonly StatementFunction[] = [
  {
    name: "summarizeCandidateDataErasureResidue",
    returns: "CandidateDataErasureResidue",
    factsParameter: 1,
    factsType: "CandidateDataErasureRunOutcome",
    factsFields: ["intakeErased", "objectStorageDeleted", "applicationsStillReferencingIntake"]
  }
];

function region(startMarker: string, endMarker: string): string {
  const start = domain.indexOf(startMarker);
  assert.ok(start >= 0, `could not locate ${JSON.stringify(startMarker)} in packages/domain/src/index.ts`);
  const end = domain.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not locate the end of ${JSON.stringify(startMarker)}`);
  return domain.slice(start, end + endMarker.length);
}

for (const fn of STATEMENT_FUNCTIONS) {
  test(`${fn.name} is declared once, so no overload can drop its facts`, () => {
    assert.equal(domain.split(`function ${fn.name}`).length - 1, 1);
  });

  test(`${fn.name} requires its ${fn.factsType}: no ? marker and no default`, () => {
    const signature = region(`export function ${fn.name}(`, `): ${fn.returns} {`);
    const parameters = signature
      .slice(signature.indexOf("(") + 1, signature.lastIndexOf("):"))
      .split(/,(?![^{]*\})/u)
      .map((parameter) => parameter.trim())
      .filter((parameter) => parameter.length > 0);
    assert.match(
      parameters[fn.factsParameter] ?? "",
      new RegExp(`^[A-Za-z_]\\w*\\s*:\\s*${fn.factsType}$`, "u"),
      `parameter ${fn.factsParameter} must be a plain required ${fn.factsType}, found: ${parameters.join(" | ")}`
    );
  });

  test(`${fn.name} does not reintroduce a default in its body`, () => {
    const signatureEnd = `): ${fn.returns} {`;
    const body = region(signatureEnd, "\n}\n");
    const name = (() => {
      const signature = region(`export function ${fn.name}(`, signatureEnd);
      const parameters = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf("):")).split(",");
      return (parameters[fn.factsParameter] ?? "").split(":")[0]?.trim() ?? "";
    })();
    assert.ok(name.length > 0, "the facts parameter must be locatable");
    assert.doesNotMatch(body, new RegExp(`\\b${name}\\s*\\?\\?`, "u"), "no nullish fallback for the facts");
    assert.doesNotMatch(body, new RegExp(`\\b${name}\\s*\\?\\.`, "u"), "the facts are required, so never optional-chained");
    assert.doesNotMatch(body, new RegExp(`\\b${name}\\s*=(?!=)`, "u"), "no reassignment to a default");
  });

  test(`${fn.factsType}'s fields are all required`, () => {
    const declaration = region(`export interface ${fn.factsType} {`, "\n}\n");
    for (const field of fn.factsFields) {
      assert.match(declaration, new RegExp(`readonly ${field}:`, "u"), `${field} must be declared required`);
      assert.doesNotMatch(declaration, new RegExp(`${field}\\s*\\?`, "u"), `${field} must not be optional`);
    }
  });
}
