import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The `?auth=` code lookup on the public sign-in page, against the inputs
 * a public query parameter actually invites.
 *
 * Review #88 (Copilot, medium): the mapping was a plain object literal,
 * so `?auth=__proto__` resolved to `Object.prototype` and
 * `?auth=constructor` to a function. Both are truthy, so the `?? generic`
 * fallback never fired, and React throws when handed a non-element
 * object -- an unauthenticated crash on the one page a stranger can
 * always reach, triggered by sending someone a link.
 *
 * "Closed map" was written in the comment and was not true of the code.
 * This is the test that makes it true of the code.
 */

/**
 * Imported through a runtime-built specifier for the reason spelled out
 * in tests/support/web-route-loader.ts: a static import would pull
 * apps/web into tests/tsconfig.json, which typechecks with module
 * NodeNext and would then read this ESM file as CommonJS (TS1295).
 */
const authCodes = (await import(
  new URL("../../apps/web/src/lib/auth-codes.ts", import.meta.url).href
)) as {
  authFailureMessage(code: string): string;
  AUTH_FAILURE_MESSAGES: ReadonlyMap<string, string>;
  GENERIC_AUTH_FAILURE: string;
};

/** Every one of these is a real key on `Object.prototype` or an object
 * literal's inherited surface, and every one is a value an attacker can
 * put in a link they send to someone else. */
const INHERITED_KEYS = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString"
] as const;

test("an inherited property name yields the generic message, not an object or a function", () => {
  for (const key of INHERITED_KEYS) {
    const message = authCodes.authFailureMessage(key);
    assert.equal(
      typeof message,
      "string",
      `?auth=${key} produced a ${typeof message}, which React cannot render`
    );
    assert.equal(message, authCodes.GENERIC_AUTH_FAILURE);
  }
});

test("the lookup returns a string for arbitrary input, which is what the page renders", () => {
  for (const code of ["", " ", "nope", "../../etc/passwd", "<script>", "0", "null", "undefined"]) {
    assert.equal(typeof authCodes.authFailureMessage(code), "string");
  }
});

/**
 * The codes are read out of the redeem route's source, not restated here
 * (review #88, REV-006).
 *
 * The test below warns that a code the route emits without a message here
 * degrades to the generic one -- safe, but back to the undiagnosable bounce
 * this page exists to end. A hardcoded list cannot fail on that drift: it
 * would restate the claim instead of checking it. Reading the route means
 * adding a fifth `?auth=` code without a message breaks this test, which is
 * what the warning promises.
 */
function codesEmittedByRedeemRoute(): readonly string[] {
  const routePath = fileURLToPath(
    new URL("../../apps/web/src/app/auth/redeem/route.ts", import.meta.url)
  );
  const source = readFileSync(routePath, "utf8");
  // Only the redirect targets, so the file's own prose about `?auth=<reason>`
  // is not mistaken for an emitted code.
  const codes = [...source.matchAll(/"\/\?auth=([a-z_]+)"/gu)].map((match) => match[1] as string);
  assert.ok(codes.length > 0, "expected to find the ?auth= codes in the redeem route source");
  return [...new Set(codes)];
}

test("every code the redeem route emits has its own distinguishable message", () => {
  const emitted = codesEmittedByRedeemRoute();
  const messages = new Set<string>();
  for (const code of emitted) {
    const message = authCodes.authFailureMessage(code);
    assert.notEqual(
      message,
      authCodes.GENERIC_AUTH_FAILURE,
      `${code} is emitted by GET /auth/redeem and has no message of its own`
    );
    messages.add(message);
  }
  assert.equal(messages.size, emitted.length, "each emitted code must be distinguishable from the others");
});

test("the map carries exactly the codes the redeem route emits, no more", () => {
  // The other direction: a message for a code nothing emits is dead weight
  // that reads like live behaviour.
  assert.deepEqual(
    [...authCodes.AUTH_FAILURE_MESSAGES.keys()].sort(),
    [...codesEmittedByRedeemRoute()].sort()
  );
});
