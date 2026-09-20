import assert from "node:assert/strict";
import test from "node:test";

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

test("the four codes the redeem route actually emits each get their own message", () => {
  // These are the exact values GET /auth/redeem redirects with. A code it
  // emits that is missing here would silently degrade to the generic
  // message -- still safe, but back to the undiagnosable bounce this
  // page exists to end.
  const emitted = ["missing_token", "invalid_link", "no_account", "error"];
  const messages = new Set<string>();
  for (const code of emitted) {
    const message = authCodes.authFailureMessage(code);
    assert.notEqual(message, authCodes.GENERIC_AUTH_FAILURE, `${code} must have its own message`);
    messages.add(message);
  }
  assert.equal(messages.size, emitted.length, "each emitted code must be distinguishable from the others");
});

test("the map carries nothing beyond the codes the redeem route emits", () => {
  assert.deepEqual(
    [...authCodes.AUTH_FAILURE_MESSAGES.keys()].sort(),
    ["error", "invalid_link", "missing_token", "no_account"]
  );
});
