import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_SOURCE = path.join(repositoryRoot, "packages", "db", "src", "index.ts");

/**
 * Pooling trades a handshake per call for a connection shared between callers,
 * and that trade has exactly one way to go wrong: session state set by one
 * borrower still being set for the next.
 *
 * It is not hypothetical here. packages/db runs `SET search_path`,
 * `SET LOCAL ROLE` and `set_config('app.current_org_id', ...)`. On a pooled
 * connection a leaked search_path would silently send a later query to another
 * tenant's schema, which is worse than any latency pooling removes. The probe
 * helpers that need those statements keep their own dedicated `Client`; this
 * asserts that split holds, rather than trusting a comment saying it does.
 *
 * Session-scoped versus transaction-scoped is the whole distinction:
 * `SET LOCAL` and `set_config(..., true)` revert on COMMIT or ROLLBACK and are
 * safe on a shared connection. Plain `SET` and `set_config(..., false)` do not.
 */

interface DatabaseFunction {
  readonly name: string;
  readonly startLine: number;
  readonly body: readonly string[];
  readonly pooled: boolean;
}

function databaseFunctions(): readonly DatabaseFunction[] {
  const lines = fs.readFileSync(DB_SOURCE, "utf8").split("\n");
  const starts: { name: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const match = /^(?:export )?(?:async )?function (\w+)/u.exec(line);
    if (match?.[1] !== undefined) {
      starts.push({ name: match[1], index });
    }
  });

  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    const body = lines.slice(start.index, end);
    return {
      name: start.name,
      startLine: start.index + 1,
      body,
      pooled: body.some((line) => line.includes("await acquireConnection("))
    };
  });
}

/** Statements whose effect outlives the transaction and therefore the
 * borrower. `SET LOCAL` is excluded because it does not. */
function sessionScopedStatements(body: readonly string[]): readonly string[] {
  const offenders: string[] = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    // Statement-initial only. `UPDATE ... SET column = value` is a column
    // assignment, not a session setting, and its SET routinely lands on its
    // own line, so matching SET anywhere flags every writer in the file.
    if (/["'`]\s*SET\s+(?!LOCAL\b)/iu.test(trimmed)) {
      offenders.push(trimmed);
      continue;
    }
    if (/set_config\([^)]*,\s*false\s*\)/iu.test(trimmed)) {
      offenders.push(trimmed);
      continue;
    }
    if (/["'`]\s*(DISCARD|LISTEN|UNLISTEN|DEALLOCATE)\b/iu.test(trimmed)) {
      offenders.push(trimmed);
    }
  }
  return offenders;
}

test("no pooled function sets session state that would leak to the next borrower", () => {
  const offenders = databaseFunctions()
    .filter((fn) => fn.pooled)
    .flatMap((fn) =>
      sessionScopedStatements(fn.body).map(
        (statement) => `${fn.name} (line ${fn.startLine}) issues session-scoped: ${statement}`
      )
    );

  assert.deepEqual(
    offenders,
    [],
    "these functions borrow a pooled connection and set state that outlives their transaction, so it would " +
      `still be set for whoever borrows that connection next:\n${offenders.join("\n")}\n` +
      "Use SET LOCAL or set_config(..., true) inside a transaction, or keep a dedicated Client."
  );
});

test("every pooled function releases its connection", () => {
  // Acquire without release does not fail visibly: the first ten calls work,
  // then the pool is exhausted and every later caller waits on a connection
  // that is never coming back. Cheap to check structurally, so it is.
  const offenders = databaseFunctions()
    .filter((fn) => fn.pooled)
    .filter((fn) => !fn.body.some((line) => line.includes("client.release()")))
    .map((fn) => `${fn.name} (line ${fn.startLine})`);

  assert.deepEqual(offenders, [], `these functions acquire a pooled connection and never release it:\n${offenders.join("\n")}`);
});

test("the pooled and dedicated-client split is real, so neither check is vacuous", () => {
  const functions = databaseFunctions();
  const pooled = functions.filter((fn) => fn.pooled);
  const dedicated = functions.filter((fn) => fn.body.some((line) => line.includes("new Client({")));

  // If a refactor collapsed everything onto one style, the assertions above
  // would pass while checking nothing.
  assert.ok(pooled.length > 20, `expected the request path to be pooled, found ${pooled.length} pooled functions`);
  assert.ok(
    dedicated.length > 5,
    `expected the schema-manipulating probes to keep dedicated clients, found ${dedicated.length}`
  );

  // And the probes must be the dedicated ones, because they are the functions
  // that legitimately need session state.
  //
  // This leans on a naming convention, so state it: in packages/db, `assert*`
  // and `provision*` are integration probes that own their connection.
  // A runtime precondition that runs on the request path is named `require*`
  // or `ensure*` instead, and may pool. Review #83 hit this when a new
  // request-path guard was called assertMembershipLookupVisibleOnce and was
  // flagged here; it was renamed rather than exempted, because the name was
  // the thing that was wrong.
  //
  // One exception, named rather than pattern-matched: the probe whose subject
  // IS the pool has to borrow from it to measure anything. It sets no session
  // state, which the first test in this file checks independently, so the
  // exemption does not widen what is allowed.
  const POOLED_PROBE_EXEMPTIONS = ["assertConnectionsAreReused"] as const;
  const pooledProbes = pooled
    .filter((fn) => fn.name.startsWith("assert") || fn.name.startsWith("provision"))
    .map((fn) => fn.name)
    .filter((name) => !POOLED_PROBE_EXEMPTIONS.includes(name as (typeof POOLED_PROBE_EXEMPTIONS)[number]));
  assert.deepEqual(
    pooledProbes,
    [],
    `these probes manipulate schemas and must not use a pooled connection:\n${pooledProbes.join("\n")}`
  );

  // The exemption expires if that probe stops being pooled, rather than
  // sitting here permitting something that no longer happens.
  for (const name of POOLED_PROBE_EXEMPTIONS) {
    assert.ok(
      pooled.some((fn) => fn.name === name),
      `${name} is exempted as a deliberately pooled probe but no longer uses a pooled connection; remove the exemption`
    );
  }
});
