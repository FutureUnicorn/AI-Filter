import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-55, from a review finding: describeReviewTimeReduction existed,
// was tested from both sides, and no shipped code called it. A metric
// nothing reaches is not a feature, and nothing in the build said so --
// unit tests pass either way, and "is it wired" is not a question a
// human reviewer reliably re-asks on every metric.
//
// So it is asked here instead. Every function in packages/domain that
// returns a MetricSample must be referenced by something under apps/,
// or be listed below with the ticket that will wire it. The exemption
// list is self-expiring: an entry that IS wired fails this suite, so
// the list shrinks on its own rather than becoming a permanent excuse.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Not yet reachable, and why. Keyed by function name; the value is the
 * ticket that owns the gap.
 */
const AWAITING_A_CALLER: Readonly<Record<string, string>> = {
  // AF-58 computes the rate and packages/db can read the counts
  // (getFailedDocumentRate), but no route exposes it. Wiring it is a
  // second public endpoint and a second authorization decision, which
  // belongs to AF-58 rather than to the review-time ticket that found it.
  describeFailedDocumentRate: "AF-58 needs its own reporting route"
};

function metricFunctions(): readonly string[] {
  const domain = readFileSync(join(repositoryRoot, "packages/domain/src/index.ts"), "utf8");
  return [...domain.matchAll(/export function (describe\w+)\([^)]*\):\s*MetricSample/gu)].map((match) => {
    const [, name] = match;
    return name ?? "";
  });
}

function filesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === ".next" ? [] : filesUnder(path);
    }
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

const applicationSources = filesUnder(join(repositoryRoot, "apps")).map((path) => readFileSync(path, "utf8"));

/**
 * A CALL, not a mention. `source.includes(name)` would be satisfied by
 * the import statement alone, so a route that imported the function and
 * never called it would pass the guard whose entire purpose is to catch
 * exactly that. An import is what "declared but unwired" looks like.
 */
function isReachable(name: string): boolean {
  const called = new RegExp(String.raw`\b${name}\s*\(`, "u");
  return applicationSources.some((source) => called.test(source));
}

test("the metric functions this suite guards are actually found in the domain", () => {
  // A regex that matches nothing would make every assertion below pass.
  const found = metricFunctions();
  assert.ok(found.length >= 2, `expected the MetricSample producers to be discoverable, found: ${found.join(", ")}`);
  assert.ok(found.includes("describeReviewTimeReduction"));
});

test("every metric the domain can produce is reachable from a shipped application", () => {
  const unreachable = metricFunctions().filter(
    (name) => !isReachable(name) && AWAITING_A_CALLER[name] === undefined
  );
  assert.deepEqual(
    unreachable,
    [],
    `computed but unreachable, so no customer or report can ever see it: ${unreachable.join(", ")}`
  );
});

test("no shipped surface lets a caller name the provenance of a review-time baseline", () => {
  // REV-002. `source` decides whether the reader is told the two sides
  // of the comparison were not measured the same way, so a request that
  // can set it is a request that can delete that warning.
  //
  // Asserted as "the property is a string literal" rather than as "the
  // file does not contain measured_preassist", because the defect this
  // guards never contained that string: it read
  // searchParams.get("baselineSource") and passed it straight through.
  // A guard matching the literal would have been green throughout.
  const baselineBuilders = filesUnder(join(repositoryRoot, "apps"))
    .map((path) => [path, readFileSync(path, "utf8")] as const)
    .filter(([, source]) => source.includes("reviewTimeBaselineSchema") || source.includes("ReviewTimeBaseline"));

  assert.ok(baselineBuilders.length > 0, "expected at least one app surface to build a review-time baseline");
  for (const [path, source] of baselineBuilders) {
    const assignments = [...source.matchAll(/\bsource:\s*(.{0,40})/gu)].map((match) => match[1] ?? "");
    assert.ok(assignments.length > 0, `${path} builds a baseline but never sets source`);
    for (const assignment of assignments) {
      assert.match(
        assignment,
        /^"(?:employer_reported)"/u,
        `${path} must fix the baseline source to a literal the server owns, got: source: ${assignment}`
      );
    }
  }
});

test("an exemption that is no longer needed fails, so the list cannot outlive the gap", () => {
  const stale = Object.keys(AWAITING_A_CALLER).filter((name) => isReachable(name));
  assert.deepEqual(stale, [], `now wired, so remove the exemption: ${stale.join(", ")}`);
  const gone = Object.keys(AWAITING_A_CALLER).filter((name) => !metricFunctions().includes(name));
  assert.deepEqual(gone, [], `exempted but no longer a metric function: ${gone.join(", ")}`);
});
