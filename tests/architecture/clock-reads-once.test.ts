import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// #79 REV-010, and the class behind it.
//
// A function that reads the database clock in its own round trip and then
// writes a value derived from that read has two instants, not one. If
// anything in the same row is stamped by a DEFAULT or a trigger, those
// two instants can disagree, and a constraint comparing them can refuse a
// request that was never wrong. A network round trip is exactly where an
// NTP correction has room to land.
//
// `createAuditReportShareLink` did this: it read `SELECT clock_timestamp()`,
// computed `expires_at` in JS, and inserted it alongside a `created_at`
// the BEFORE INSERT trigger stamped from a second `clock_timestamp()`. The
// ceiling CHECK compares the two. It now derives the expiry inside the
// INSERT.
//
// A behavioural regression test is not available here: the two shapes
// differ only by the duration of a round trip, around 1.1ms apart on this
// machine, and a threshold between them would be a flake rather than a
// test. So the property is pinned structurally, which is deterministic.
//
// The exemption list is self-expiring: an entry whose function no longer
// does this fails the last case, so the list shrinks on its own.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = join(repositoryRoot, "packages/db/src/index.ts");

/**
 * Functions permitted a standalone clock round trip, and why. Keyed by
 * function name.
 */
const MAY_READ_THE_CLOCK_SEPARATELY: Readonly<Record<string, string>> = {
  // Writes the exact value it read into the row, as text, so the instant
  // it validated against and the instant it stored are the same one.
  // Nothing else in that row is stamped independently.
  extendPrivacyRequest: "stores the exact instant it read, so there is only one",
  // Probes, which build fixtures and assert against them rather than
  // serving a request.
  assertPrivacyRequestExtension: "probe: drives the extension window deliberately"
};

function enclosingFunctionAt(source: string): (lineIndex: number) => string {
  const owners: string[] = [];
  let current = "(file scope)";
  for (const line of source.split("\n")) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/u.exec(line);
    if (declaration?.[1] !== undefined) {
      current = declaration[1];
    }
    owners.push(current);
  }
  return (lineIndex: number): string => owners[lineIndex] ?? "(file scope)";
}

test("no production function reads the database clock in its own round trip", () => {
  const source = readFileSync(SOURCE, "utf8");
  const ownerAt = enclosingFunctionAt(source);
  const offenders: string[] = [];
  source.split("\n").forEach((line, index) => {
    // A clock read that is the whole point of the statement, rather than
    // one term inside a larger INSERT or UPDATE.
    if (!/`?\s*SELECT\s+(clock_timestamp\(\)|CURRENT_TIMESTAMP)[^,]*AS\s+now/iu.test(line)) {
      return;
    }
    const owner = ownerAt(index);
    if (owner in MAY_READ_THE_CLOCK_SEPARATELY) {
      return;
    }
    offenders.push(`packages/db/src/index.ts:${index + 1} inside ${owner}`);
  });
  assert.deepEqual(
    offenders,
    [],
    "a standalone clock round trip gives the caller a second instant, which can disagree with any " +
      "DEFAULT or trigger stamping the same row. Derive the value inside the statement that writes " +
      "it, or add the function to MAY_READ_THE_CLOCK_SEPARATELY with why one instant is all it has:\n" +
      offenders.join("\n")
  );
});

test("createAuditReportShareLink derives the expiry inside the INSERT", () => {
  const source = readFileSync(SOURCE, "utf8");
  const body = /export async function createAuditReportShareLink[\s\S]*?\n\}\n/u.exec(source)?.[0];
  assert.ok(body !== undefined, "createAuditReportShareLink not found; has it been renamed?");
  assert.match(
    body,
    /clock_timestamp\(\)\s*\+\s*make_interval\(days\s*=>/u,
    "the expiry must come from the database clock in the same statement that writes created_at, " +
      "not from a value computed in the application"
  );
});

test("the exemption list names only functions that still read the clock separately", () => {
  const source = readFileSync(SOURCE, "utf8");
  const ownerAt = enclosingFunctionAt(source);
  const stillReading = new Set<string>();
  source.split("\n").forEach((line, index) => {
    if (/`?\s*SELECT\s+(clock_timestamp\(\)|CURRENT_TIMESTAMP)[^,]*AS\s+now/iu.test(line)) {
      stillReading.add(ownerAt(index));
    }
  });
  const stale = Object.keys(MAY_READ_THE_CLOCK_SEPARATELY).filter((name) => !stillReading.has(name));
  assert.deepEqual(
    stale,
    [],
    `MAY_READ_THE_CLOCK_SEPARATELY excuses functions that no longer need excusing. Self-expiring on ` +
      `purpose: delete these entries.\n${stale.join("\n")}`
  );
});
