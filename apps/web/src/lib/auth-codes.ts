/**
 * The `?auth=` codes `GET /auth/redeem` redirects to `/` with, and the
 * message each one gets.
 *
 * Its own module rather than a constant inside page.tsx so the claim it
 * makes can actually be tested: the page is a client component, and a
 * test that rebuilt this map itself would prove nothing about the page
 * that ships.
 *
 * A `Map`, not an object literal, and that is the security property
 * rather than a style preference (review #88). Indexing a plain object
 * with a caller-supplied key is not a closed lookup: `__proto__` returns
 * `Object.prototype` and `constructor` returns a function, both truthy,
 * so a `?? generic` fallback never fires and React throws on being handed
 * a non-element object. That is an unauthenticated crash on the one page
 * a stranger can always reach, reachable by sending someone a link. A
 * `Map` has no inherited keys, so a miss is a miss.
 *
 * The messages are fixed text, never anything taken from the query
 * string: a page that renders whatever it is handed can be linked to
 * with someone else's wording.
 */
export const AUTH_FAILURE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["missing_token", "That sign-in link was incomplete. Request a new one below."],
  [
    "invalid_link",
    "That sign-in link has expired or was already used. Sign-in links work once; request a new one below."
  ],
  [
    "no_account",
    "That link is valid, but no account here matches its email address. Ask an owner or admin of your organization to invite you."
  ],
  ["error", "Something went wrong while signing you in. Request a new link and try again."]
]);

export const GENERIC_AUTH_FAILURE = "Sign-in did not complete. Request a new link below.";

/**
 * The message to show for a code, for any input at all.
 *
 * Returns a string unconditionally, which is the whole contract: the
 * caller renders the result, so "always a string" is what keeps an
 * attacker-chosen `?auth=` value from reaching React as something else.
 */
export function authFailureMessage(code: string): string {
  return AUTH_FAILURE_MESSAGES.get(code) ?? GENERIC_AUTH_FAILURE;
}
