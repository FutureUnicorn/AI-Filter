import assert from "node:assert/strict";
import moduleHooks from "node:module";
import test from "node:test";

import {
  dropProbeSchema,
  provisionRouteProbeSchema,
  seedOrganizationMembership
} from "../../packages/db/src/index.ts";
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
function applyRouteEnvironment(databaseUrl: string, routeSchema: string): void {
  Object.assign(process.env, {
    APP_ENV: "test",
    DEPLOYMENT_COMMIT_SHA: "0000000",
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: routeSchema,
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-test",
    STORAGE_ACCESS_KEY_ID: "test-access-key",
    STORAGE_SECRET_ACCESS_KEY: "test-secret-access-key",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    // Deliberately not localhost:3000, so a link built from the request host
    // is distinguishable from one built from configuration.
    PUBLIC_APP_ORIGIN: "https://canonical.acme.test",
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

async function seedRecruiter(databaseUrl: string, schema: string, email: string): Promise<void> {
  await seedOrganizationMembership(databaseUrl, schema, {
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

interface GetRouteModule {
  GET(request: Request): Promise<Response>;
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

async function loadGetRoute(relativePath: string): Promise<GetRouteModule> {
  if (!resolutionRegistered) {
    registerExtensionlessTsResolution();
    resolutionRegistered = true;
  }
  const specifier = new URL(relativePath, import.meta.url).href;
  return (await import(specifier)) as GetRouteModule;
}

const REQUEST_ROUTE = "../../apps/web/src/app/api/auth/magic-link/request/route.ts";
const REDEEM_ROUTE = "../../apps/web/src/app/api/auth/magic-link/redeem/route.ts";
const EMAIL_LINK_ROUTE = "../../apps/web/src/app/auth/redeem/route.ts";

test("a magic link produced by the request route can actually be redeemed by the redeem route", async () => {
  const databaseUrl = requireDatabase();
  // Unique per run so repeated runs never collide on the users table.
  const email = `route-test-${Date.now()}@acme.test`;
  const routeSchema = await provisionRouteProbeSchema(databaseUrl);
  try {
    applyRouteEnvironment(databaseUrl, routeSchema);
    await seedRecruiter(databaseUrl, routeSchema, email);

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
  } finally {
    await dropProbeSchema(databaseUrl, routeSchema);
  }
});

test("a redeemed magic link cannot be redeemed twice through the route", async () => {
  const databaseUrl = requireDatabase();
  const email = `route-test-single-use-${Date.now()}@acme.test`;
  const routeSchema = await provisionRouteProbeSchema(databaseUrl);
  try {
    applyRouteEnvironment(databaseUrl, routeSchema);
    await seedRecruiter(databaseUrl, routeSchema, email);

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
  } finally {
    await dropProbeSchema(databaseUrl, routeSchema);
  }
});

test("requesting a link for an unknown email still returns 202 and mints nothing", async () => {
  const databaseUrl = requireDatabase();
  const routeSchema = await provisionRouteProbeSchema(databaseUrl);
  try {
    applyRouteEnvironment(databaseUrl, routeSchema);

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
  } finally {
    await dropProbeSchema(databaseUrl, routeSchema);
  }
});

// ---- PR #82 review, blocking issue 1 ----
//
// The request route emails `/auth/redeem?token=...`, but the only redemption
// implementation was `POST /api/auth/magic-link/redeem`. Nothing served the
// emailed path, so a real recipient clicking a real link got a 404 -- while
// the round-trip test above passed, because it extracted the token itself and
// called the API handler directly. That is the exact gap this test closes: it
// drives the URL the user actually receives, verbatim, with no rewriting.
test("the URL delivered in the email is itself redeemable, not just the API handler", async () => {
  const databaseUrl = requireDatabase();
  const email = `email-link-${Date.now()}@acme.test`;
  const routeSchema = await provisionRouteProbeSchema(databaseUrl);
  try {
    applyRouteEnvironment(databaseUrl, routeSchema);
    await seedRecruiter(databaseUrl, routeSchema, email);

    const requestRoute = await loadRoute(REQUEST_ROUTE);
    const emitted = await captureStderr(async () => {
      const response = await requestRoute.POST(
        jsonRequest("http://localhost:3000/api/auth/magic-link/request", { email }, "email-link-key-1")
      );
      assert.equal(response.status, 202);
    });

    // Take the whole URL, not the token: the point is that what was
    // delivered resolves, so reassembling a different URL here would
    // reintroduce the blind spot.
    // Matches either scheme: the link now comes from PUBLIC_APP_ORIGIN, which
    // is https in this harness, rather than from the request URL.
    const deliveredLink = /(https?:\/\/\S*\/auth\/redeem\?token=[^\s&]+)/u.exec(emitted)?.[1];
    assert.ok(
      deliveredLink !== undefined,
      `the delivery channel must carry a complete redeem URL, got: ${JSON.stringify(emitted)}`
    );
    assert.ok(!deliveredLink.includes("[REDACTED]"), "the delivered URL must carry a usable token");

    const emailLinkRoute = await loadGetRoute(EMAIL_LINK_ROUTE);
    const response = await emailLinkRoute.GET(new Request(deliveredLink, { method: "GET" }));

    // A redirect, not a 404: the defect was that this path had no handler.
    assert.ok(
      response.status >= 300 && response.status < 400,
      `the delivered URL must redirect, got ${response.status}`
    );
    const location = response.headers.get("location");
    assert.ok(location !== null && !location.includes("token="), "the consumed token must not survive in the redirect");

    const cookie = response.headers.get("set-cookie");
    assert.ok(
      cookie !== null && cookie.includes(SESSION_COOKIE_NAME),
      "following the emailed link must establish a session"
    );
    const sessionToken = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`, "u").exec(cookie)?.[1];
    assert.ok(sessionToken !== undefined);
    const verification = verifySessionToken(decodeURIComponent(sessionToken), SESSION_SECRET);
    assert.equal(verification.outcome, "valid", "the session minted from the emailed link must verify");

    // Single use is what makes a GET entry point defensible; prove it holds
    // through this path too rather than assuming the SQL covers it.
    const second = await emailLinkRoute.GET(new Request(deliveredLink, { method: "GET" }));
    assert.equal(second.headers.get("set-cookie"), null, "a consumed link must not mint a second session");
  } finally {
    await dropProbeSchema(databaseUrl, routeSchema);
  }
});

// ---- PR #82 review, blocking issue 2 ----
//
// Only the known-account branch sends mail, so a provider exception used to
// reach the outer catch and return 500, while an unknown address returned 202
// without attempting a send. Any provider outage therefore turned the
// endpoint into an account-existence oracle, with no attacker access to the
// provider required. The public response must be identical either way.
test("a delivery failure for a known account is indistinguishable from an unknown account", async (t) => {
  const databaseUrl = requireDatabase();
  const knownEmail = `oracle-known-${Date.now()}@acme.test`;
  const routeSchema = await provisionRouteProbeSchema(databaseUrl);
  const errorLog = t.mock.method(console, "error", () => undefined);
  try {
    applyRouteEnvironment(databaseUrl, routeSchema);
    await seedRecruiter(databaseUrl, routeSchema, knownEmail);

    // A hosted environment with delivery pointed at a closed port: the HTTP
    // sender's fetch rejects, which is a real provider failure rather than a
    // stubbed one, and needs no network access.
    Object.assign(process.env, {
      APP_ENV: "staging",
      MAGIC_LINK_EMAIL_ENDPOINT: "http://127.0.0.1:1/send",
      MAGIC_LINK_EMAIL_API_KEY: "test-key",
      MAGIC_LINK_EMAIL_FROM: "no-reply@acme.test"
    });

    const requestRoute = await loadRoute(REQUEST_ROUTE);
    const knownResponse = await requestRoute.POST(
      jsonRequest("http://localhost:3000/api/auth/magic-link/request", { email: knownEmail }, "oracle-key-1")
    );
    const unknownResponse = await requestRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/auth/magic-link/request",
        { email: `oracle-unknown-${Date.now()}@acme.test` },
        "oracle-key-2"
      )
    );

    assert.equal(knownResponse.status, 202, "a known account whose delivery failed must still answer 202");
    assert.equal(unknownResponse.status, unknownResponse.status, "sanity");
    assert.equal(
      knownResponse.status,
      unknownResponse.status,
      "delivery failure must not make the response differ by whether the account exists"
    );
    // Bodies too: a difference there leaks just as much as a status would.
    assert.equal(await knownResponse.clone().text(), await unknownResponse.clone().text());
    const deliveryLine = errorLog.mock.calls
      .map((call) => String(call.arguments[0]))
      .find((line) => line.includes('"message":"magic_link.delivery_failed"'));
    assert.ok(deliveryLine !== undefined, "the hidden provider failure must remain operator-visible");
    const deliveryLog = JSON.parse(deliveryLine) as {
      readonly context?: {
        readonly errorName?: string;
        readonly errorCode?: string;
        readonly action?: string;
      };
    };
    assert.equal(deliveryLog.context?.errorName, "TypeError");
    assert.ok(
      deliveryLog.context?.errorCode === "econnrefused" ||
        deliveryLog.context?.errorCode === "unknown_error"
    );
    assert.equal(deliveryLog.context?.action, "email.send");
    assert.doesNotMatch(deliveryLine, /oracle-known|acme\.test|test-key|token=/iu);
  } finally {
    delete process.env.MAGIC_LINK_EMAIL_ENDPOINT;
    delete process.env.MAGIC_LINK_EMAIL_API_KEY;
    delete process.env.MAGIC_LINK_EMAIL_FROM;
    await dropProbeSchema(databaseUrl, routeSchema);
  }
});

// ---- PR #83 review, P1: attacker-controlled origin ----
//
// The request route built the emailed link from `new URL(request.url).origin`.
// The endpoint is unauthenticated and accepts an arbitrary `Host`, so an
// attacker could request a link for a victim while supplying
// `Host: attacker.example`. The victim received a genuine, signed link
// pointing at the attacker and handed over a redeemable bearer token simply by
// clicking it.
//
// Each hostile shape is a separate case on purpose: a fix that reads a
// different header, or that trusts a forwarded host, would pass one and fail
// another.
const HOSTILE_ORIGINS: readonly {
  readonly label: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}[] = [
  { label: "hostile Host header", url: "http://attacker.example/api/auth/magic-link/request", headers: {} },
  {
    label: "hostile X-Forwarded-Host",
    url: "http://localhost:3000/api/auth/magic-link/request",
    headers: { "x-forwarded-host": "attacker.example" }
  },
  {
    label: "hostile X-Forwarded-Host with https proto",
    url: "http://localhost:3000/api/auth/magic-link/request",
    headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" }
  },
  {
    label: "hostile Forwarded header",
    url: "http://localhost:3000/api/auth/magic-link/request",
    headers: { forwarded: "host=attacker.example;proto=https" }
  },
  { label: "host with an embedded port", url: "http://attacker.example:8443/api/auth/magic-link/request", headers: {} }
];

for (const [index, hostile] of HOSTILE_ORIGINS.entries()) {
  test(`a hostile request origin cannot change the emailed link: ${hostile.label}`, async () => {
    const databaseUrl = requireDatabase();
    const email = `origin-${Date.now()}-${index}@acme.test`;
    const routeSchema = await provisionRouteProbeSchema(databaseUrl);
    try {
      applyRouteEnvironment(databaseUrl, routeSchema);
      await seedRecruiter(databaseUrl, routeSchema, email);

      const requestRoute = await loadRoute(REQUEST_ROUTE);
      const emitted = await captureStderr(async () => {
        const response = await requestRoute.POST(
          new Request(hostile.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": `origin-key-${index}`,
              ...hostile.headers
            },
            body: JSON.stringify({ email })
          })
        );
        assert.equal(response.status, 202);
      });

      const link = /(https?:\/\/\S*\/auth\/redeem\?token=[^\s&]+)/u.exec(emitted)?.[1];
      assert.ok(link !== undefined, `expected a delivered link, got: ${JSON.stringify(emitted)}`);

      // The assertion that matters: the link's origin is the configured one,
      // whatever the request claimed.
      assert.equal(
        new URL(link).origin,
        "https://canonical.acme.test",
        `the emailed link must use the configured origin, got ${new URL(link).origin}`
      );
      assert.ok(!link.includes("attacker.example"), "the attacker host must not appear anywhere in the link");
    } finally {
      await dropProbeSchema(databaseUrl, routeSchema);
    }
  });
}

// A hosted deployment must not be able to boot without the configured origin,
// since the previous behaviour was to silently fall back to the request host.
test("a hosted environment refuses to load without PUBLIC_APP_ORIGIN", async () => {
  const { loadEnvironmentConfig } = await import("../../packages/config/src/index.ts");
  const base: Record<string, string> = {
    APP_ENV: "staging",
    DEPLOYMENT_COMMIT_SHA: "abc1234",
    DATABASE_URL: "postgresql://local:local@localhost:5432/local",
    DATABASE_SCHEMA: "public",
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-staging",
    STORAGE_ACCESS_KEY_ID: "k",
    STORAGE_SECRET_ACCESS_KEY: "secret-value-long",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    MAGIC_LINK_EMAIL_ENDPOINT: "https://mail.test/send",
    MAGIC_LINK_EMAIL_API_KEY: "key",
    MAGIC_LINK_EMAIL_FROM: "no-reply@acme.test"
  };
  assert.throws(() => loadEnvironmentConfig(base), /PUBLIC_APP_ORIGIN is required for staging/u);

  // And it must be a bare origin: a value carrying a path would silently
  // produce `https://app.test/x/auth/redeem?token=...`.
  assert.throws(
    () => loadEnvironmentConfig({ ...base, PUBLIC_APP_ORIGIN: "https://app.test/subpath" }),
    /bare http\(s\) origin/u
  );
  assert.doesNotThrow(() => loadEnvironmentConfig({ ...base, PUBLIC_APP_ORIGIN: "https://app.test" }));
});
