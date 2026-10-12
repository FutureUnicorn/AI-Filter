import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-54. A recorder, a table and a summary can all be correct and the
// ticket still deliver nothing, because the only thing that makes a
// baseline exist is a recruiter review creating a row. That gap is
// invisible to unit tests -- every piece passes in isolation -- and
// invisible to the type checker, because an uncalled exported function
// is not an error. So it is asserted here.
//
// The same shape as AF-53's keyboard wiring test, and for the same
// reason: no jsdom, so the plumbing cannot be exercised. What can be
// checked is that the plumbing exists and delegates to the layer the
// unit tests actually cover.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(area: string): ReadonlyArray<readonly [string, string]> {
  const collected: Array<readonly [string, string]> = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".next", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (/\.tsx?$/u.test(entry.name)) {
        collected.push([relative(repositoryRoot, absolute), readFileSync(absolute, "utf8")]);
      }
    }
  }
  visit(join(repositoryRoot, area));
  return collected;
}

const hookPath = "apps/web/src/lib/review-timing.ts";
const routePath = "apps/web/src/app/api/roles/[roleId]/applications/[applicationId]/timing/route.ts";
const reviewPagePath = "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx";

function read(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

test("a recruiter reviewing a candidate is what creates a span, not only the probe", () => {
  // The whole finding. recordReviewTimingSpan existed with exactly one
  // caller, assertReviewTimingIntegrity, which runs in a throwaway
  // schema during the integration suite. Production never called it, so
  // review_timing_spans would have been empty forever and AF-55 would
  // have had nothing to report.
  // A call, not a mention. The first version of this test looked for
  // the bare name and passed with the route deleted, because
  // recordReviewTimingSpanInputSchema in packages/contracts contains it
  // as a prefix -- a guard against dead code that was itself satisfied
  // by dead code.
  const callers = [...sourceFiles("apps"), ...sourceFiles("packages")]
    .filter(([path]) => !path.startsWith("packages/db/"))
    .filter(([, source]) => /\brecordReviewTimingSpan\s*\(/u.test(source))
    .map(([path]) => path);
  assert.notDeepEqual(
    callers,
    [],
    "no production code records a review timing span; the table can only ever be empty"
  );
});

test("the review surface measures itself", () => {
  const page = read(reviewPagePath);
  // Called, not merely imported: an unused import satisfies includes()
  // and leaves the page measuring nothing.
  assert.match(page, /useReviewTiming\s*\(/u, "the per-application review page must record its own timing");
  // Going around the hook would be a second, untested copy of the rules.
  assert.doesNotMatch(
    page,
    /fetch\([^)]*\/timing/u,
    "the page must post through the hook rather than calling the endpoint itself"
  );
});

test("the hook decides nothing about time: every rule comes from the domain", () => {
  const hook = read(hookPath);
  for (const symbol of ["beginReviewTiming", "recordReviewActivity", "sealReviewTiming"]) {
    assert.ok(hook.includes(symbol), `timing must delegate to ${symbol}`);
  }
  // A duration computed here is a rule the unit tests cannot see, which
  // is the failure mode that leaves them passing and meaningless.
  assert.doesNotMatch(hook, /Date\.now\(\)\s*[-+]/u, "the hook must read the clock, not do arithmetic on it");
  assert.ok(
    !hook.includes("REVIEW_IDLE_CUTOFF_MS"),
    "re-applying the idle cutoff here would give it two definitions that can disagree"
  );
});

test("the endpoint takes its reviewer from the session, never from the request body", () => {
  const route = read(routePath);
  assert.ok(route.includes("readSessionUserId(request)"), "the reviewer must come from the session");
  assert.ok(
    route.includes("reviewerUserId: userId"),
    "the recorded reviewer must be the session user, not a value from the payload"
  );

  const contracts = read("packages/contracts/src/index.ts");
  const start = contracts.indexOf("export const recordReviewTimingSpanInputSchema");
  assert.ok(start >= 0, "the input schema must exist");
  const rest = contracts.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  const declaration = end === -1 ? rest : rest.slice(0, end);
  // strictObject is what turns "we ignore a reviewerUserId in the body"
  // into "we reject it", which is the difference between a convention
  // and a boundary. It matters more here than for a decision: a timing
  // row is a named person's working rate.
  assert.ok(declaration.includes("z\n  .strictObject") || declaration.includes("z.strictObject"));
  assert.ok(!declaration.includes("reviewerUserId"), "the input schema must offer no way to name a reviewer");
});

test("the timing endpoint is write-only, so no per-reviewer read exists to be easy", () => {
  // This ticket's stated position is that time-per-application is a
  // product baseline and the same rows grouped by person are a
  // performance record, and that which of those exists is decided by
  // which query is easy to write. A GET here, scoped to one application
  // and answering for whoever asks, is that query in all but name.
  const route = read(routePath);
  const handlers = [...route.matchAll(/export async function ([A-Z]+)\(/gu)].map((match) => match[1]);
  assert.deepEqual(handlers, ["POST"]);

  const db = read("packages/db/src/index.ts");
  const reviewerFirstReads = [...db.matchAll(/export async function (\w*ReviewTiming\w*)\(/gu)]
    .map((match) => match[1] ?? "")
    .filter((name) => /reviewer/iu.test(name));
  assert.deepEqual(reviewerFirstReads, [], "packages/db must offer no reviewer-first read of review timing");
});
