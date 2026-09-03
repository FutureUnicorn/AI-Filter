import assert from "node:assert/strict";
import moduleHooks from "node:module";
import test from "node:test";

import { seedOrganizationMembership } from "../../packages/db/src/index.ts";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../../packages/security/src/index.ts";

/**
 * The route-level redeemability gate.
 *
 * Every other magic-link test exercises a piece: the token generator, the
 * redemption SQL, the verification decision, the console sender. All of
 * them passed while the feature was unusable end to end, because the one
 * thing nothing checked was whether a link produced by the REQUEST route
 * can actually be redeemed by the REDEEM route.
 *
 * It could not. The request route called
 * createConsoleMagicLinkEmailSender() with no argument, so the sender
 * always believed it was in development (making its own hosted-environment
 * guard dead code), and that sender then redacted the token out of its own
 * stderr output. The endpoint stored a valid token, returned 202, and left
 * no channel anywhere yielding the credential -- so the redeem endpoint,
 * and every session-gated route behind it including role creation, was
 * unreachable without hand-editing the database.
 *
 * This test drives both real route handlers against real Postgres and
 * asserts the round trip, so that failure mode cannot return silently.
 */

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_SECRET = "route-test-session-secret-at-least-32-chars";

function requireDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test drives the " +
        "magic-link request and redeem routes against a real database. Locally: run `pnpm dev:infra`, then set it " +
        "to postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local (see README.md)."
    );
  }
  return databaseUrl;
}

/**
 * The routes read process.env at request time through
 * loadEnvironmentConfig, so the environment is the only injection point
 * available without changing their signatures. Set to `test`, which
 * selects the console sender -- the same path a developer runs locally.
 */
function applyRouteEnvironment(databaseUrl: string): void {
  Object.assign(process.env, {
    APP_ENV: "test",
    DEPLOYMENT_COMMIT_SHA: "0000000",
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: "public",
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-test",
    STORAGE_ACCESS_KEY_ID: "test-access-key",
    STORAGE_SECRET_ACCESS_KEY: "test-secret-access-key",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    SESSION_SECRET
  });
  delete process.env.MAGIC_LINK_EMAIL_ENDPOINT;
  delete process.env.MAGIC_LINK_EMAIL_API_KEY;
  delete process.env.MAGIC_LINK_EMAIL_FROM;
}

/** Captures the link the console sender writes to stderr: in a local
 * environment that channel IS the delivery mechanism, so reading it is
 * exactly what a developer does by hand. */
async function captureStderr(action: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

async function seedRecruiter(databaseUrl: string, email: string): Promise<void> {
  await seedOrganizationMembership(databaseUrl, "public", {
    organizationId: ORGANIZATION_ID,
    organizationName: "Route Test Org",
    email,
    displayName: "Route Test Recruiter",
    role: "recruiter"
  });
}

function jsonRequest(url: string, body: unknown, idempotencyKey: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body)
  });
}

/**
 * apps/web source imports sibling modules extensionless (the redeem
 * route does `from "../../../../../lib/session"`), which Next's bundler
 * resolves and plain Node ESM does not. This hook adds the `.ts`
 * extension only when the bare specifier fails to resolve, so the real
 * route files load unmodified: the alternative was rewriting production
 * import specifiers to satisfy a test, which would change how Next
 * builds the app.
 */
function registerExtensionlessTsResolution(): void {
  moduleHooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (/\.[cm]?[jt]sx?$/u.test(specifier)) {
          throw error;
        }
        // `.ts` covers apps/web's own extensionless relative imports
        // (lib/session); `.js` covers package subpaths that Next resolves
        // through its bundler, such as `next/server`. Tried in that order
        // and only after the plain specifier has already failed, so this
        // never shadows a specifier Node could resolve on its own.
        for (const extension of [".ts", ".js"]) {
          try {
            return nextResolve(`${specifier}${extension}`, context);
          } catch {
            continue;
          }
        }
        throw error;
      }
    }
  });
}

let resolutionRegistered = false;

interface RouteModule {
  POST(request: Request): Promise<Response>;
}

/**
 * Loaded through a runtime-built specifier rather than a static import.
 *
 * A static `import ".../route.ts"` would pull apps/web into
 * tests/tsconfig.json, which typechecks with module NodeNext; apps/web
 * has no `"type": "module"`, so every route file is then read as
 * CommonJS and its ESM syntax fails with TS1295. Next.js compiles those
 * files with its own tsconfig, and giving apps/web a `type` field to
 * satisfy this test would change how the app itself is built.
 *
 * Node still executes the genuine handler here, so this remains a
 * route-level test: the request and redeem handlers that ship are the
 * ones being driven.
 */
async function loadRoute(relativePath: string): Promise<RouteModule> {
  if (!resolutionRegistered) {
    registerExtensionlessTsResolution();
    resolutionRegistered = true;
  }
  const specifier = new URL(relativePath, import.meta.url).href;
  return (await import(specifier)) as RouteModule;
}

const REQUEST_ROUTE = "../../apps/web/src/app/api/auth/magic-link/request/route.ts";
const REDEEM_ROUTE = "../../apps/web/src/app/api/auth/magic-link/redeem/route.ts";

test("a magic link produced by the request route can actually be redeemed by the redeem route", async () => {
  const databaseUrl = requireDatabase();
  // Unique per run so repeated runs never collide on the users table.
  const email = `route-test-${Date.now()}@acme.test`;
  applyRouteEnvironment(databaseUrl);
  await seedRecruiter(databaseUrl, email);

  const requestRoute = await loadRoute(REQUEST_ROUTE);
  const redeemRoute = await loadRoute(REDEEM_ROUTE);

  let requestStatus = 0;
  const emitted = await captureStderr(async () => {
    const response = await requestRoute.POST(
      jsonRequest("http://localhost:3000/api/auth/magic-link/request", { email }, "request-key-1")
    );
    requestStatus = response.status;
  });
  assert.equal(requestStatus, 202, "requesting a link for a real member must be accepted");

  // The credential must be obtainable. Before this round the same
  // assertion failed: stderr carried only `token=[REDACTED]`.
  const token = /[?&]token=([^\s&]+)/u.exec(emitted)?.[1];
  assert.ok(
    token !== undefined && token !== "[REDACTED]",
    `a usable token must be obtainable from the local delivery channel, got: ${JSON.stringify(emitted)}`
  );

  const redeemResponse = await redeemRoute.POST(
    jsonRequest("http://localhost:3000/api/auth/magic-link/redeem", { token }, "redeem-key-1")
  );
  assert.equal(redeemResponse.status, 200, await redeemResponse.clone().text());

  const body = (await redeemResponse.json()) as { email: string; userId: string };
  assert.equal(body.email, email);

  // A session cookie that actually verifies is the point of the round
  // trip: it is the prerequisite the role-creation API sits behind.
  const cookie = redeemResponse.headers.get("set-cookie");
  assert.ok(cookie !== null && cookie.includes(SESSION_COOKIE_NAME), "redemption must set a session cookie");
  const sessionToken = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`, "u").exec(cookie)?.[1];
  assert.ok(sessionToken !== undefined, "the session cookie must carry a token");
  const verification = verifySessionToken(decodeURIComponent(sessionToken), SESSION_SECRET);
  assert.equal(verification.outcome, "valid");
  assert.equal(verification.outcome === "valid" ? verification.userId : undefined, body.userId);
});

test("a redeemed magic link cannot be redeemed twice through the route", async () => {
  const databaseUrl = requireDatabase();
  const email = `route-test-single-use-${Date.now()}@acme.test`;
  applyRouteEnvironment(databaseUrl);
  await seedRecruiter(databaseUrl, email);

  const requestRoute = await loadRoute(REQUEST_ROUTE);
  const redeemRoute = await loadRoute(REDEEM_ROUTE);

  const emitted = await captureStderr(async () => {
    await requestRoute.POST(
      jsonRequest("http://localhost:3000/api/auth/magic-link/request", { email }, "request-key-2")
    );
  });
  const token = /[?&]token=([^\s&]+)/u.exec(emitted)?.[1];
  assert.ok(token !== undefined && token !== "[REDACTED]");

  const first = await redeemRoute.POST(
    jsonRequest("http://localhost:3000/api/auth/magic-link/redeem", { token }, "redeem-key-2a")
  );
  assert.equal(first.status, 200);

  const second = await redeemRoute.POST(
    jsonRequest("http://localhost:3000/api/auth/magic-link/redeem", { token }, "redeem-key-2b")
  );
  assert.equal(second.status, 401, "a single-use token must not be redeemable twice");
});

test("requesting a link for an unknown email still returns 202 and mints nothing", async () => {
  const databaseUrl = requireDatabase();
  applyRouteEnvironment(databaseUrl);

  const requestRoute = await loadRoute(REQUEST_ROUTE);

  let status = 0;
  const emitted = await captureStderr(async () => {
    const response = await requestRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/auth/magic-link/request",
        { email: `nobody-${Date.now()}@acme.test` },
        "request-key-3"
      )
    );
    status = response.status;
  });

  // Same response as the success path, so the endpoint is not an
  // account-existence oracle -- but no credential is created either.
  assert.equal(status, 202);
  assert.equal(/[?&]token=/u.test(emitted), false, "no link may be emitted for an email with no membership");
});
