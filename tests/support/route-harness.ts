/**
 * AF-100: the repository's one way to drive an API route over HTTP.
 *
 * Before this file there were two of them. tests/integration/magic-link-route.test.ts
 * worked out the hard parts -- extensionless TypeScript resolution, loading a
 * route through a runtime-built specifier, using the genuine `NextRequest` so
 * `request.cookies` behaves -- and tests/integration/file-intake-route-errors.test.ts
 * copied them. Every other route ticket that wanted request-level coverage
 * either copied them a third time or, far more often, asserted the wiring
 * structurally by matching source text instead.
 *
 * Those structural guards are why this exists. Several of them passed against
 * the very defect they were written for: one matched a bare function name that
 * a schema constant contained as a prefix, one was satisfied by an unused
 * import, one by the function's own doc comment. A test that issues a real
 * request and reads the resulting rows cannot be satisfied by any of those.
 *
 * Two layers, because route tests need different amounts of this:
 *
 *   - the low level (`applyRouteEnvironment`, `loadRouteHandler`,
 *     `routeRequest`) is the mechanism alone, for a test that provisions its
 *     own fixtures -- file-intake-route-errors uses it that way;
 *   - `withApiRouteHarness` adds the fixtures: an isolated schema, a member
 *     per role, a role, an application and one pipeline-authored evidence
 *     outcome, plus teardown.
 *
 * What stays real: the handler, the contracts, the authorization check, the
 * session token, the database. Nothing here stubs a route's collaborators;
 * a test that needs to (object storage, say) redirects that one specifier
 * with `registerModuleRedirect`.
 */
import assert from "node:assert/strict";
import moduleHooks from "node:module";

import {
  dropProbeSchema,
  provisionApiRouteSchema,
  readProbeRows,
  type ApiRouteProbe
} from "../../packages/db/src/index.ts";
import type { MembershipRole } from "../../packages/domain/src/index.ts";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../packages/security/src/index.ts";

export const ROUTE_SESSION_SECRET = "route-harness-session-secret-at-least-32-chars";

/** Who a request is made as. "anonymous" sends no cookie at all. */
export type RouteActor = MembershipRole | "outsider" | "anonymous";

export interface RouteRequest {
  /**
   * The route's own path under `apps/web/src/app/api`, template segments and
   * all: `roles/[roleId]/applications/[applicationId]/decisions`.
   *
   * Given once, it produces both the module to import and the request URL, so
   * a test cannot drive one route at a URL belonging to another -- which is
   * exactly what a hand-written pair of strings lets it do.
   */
  readonly route: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Values for the route's `[segment]` templates. */
  readonly params?: Readonly<Record<string, string>>;
  readonly as: RouteActor;
  readonly body?: unknown;
  /** Omitted for GET; required by contract for every mutating verb. */
  readonly idempotencyKey?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RouteHarness {
  readonly probe: ApiRouteProbe;
  readonly databaseUrl: string;
  /** Issue a request against a real handler and return its real response. */
  request(input: RouteRequest): Promise<Response>;
  /** Read back what the request left in the database. */
  rows<TRow extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<readonly TRow[]>;
  /** The user id a given actor's session carries, for comparing against a row. */
  userId(actor: Exclude<RouteActor, "anonymous">): string;
}

export function requireRouteDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so route tests run against real Postgres. Locally: run " +
        "`pnpm dev:infra`, then point it at signal_audit_local (see README.md)."
    );
  }
  return databaseUrl;
}

/**
 * The environment the handlers read at request time.
 *
 * Routes load configuration through `loadEnvironmentConfig(process.env)`, so
 * this is the only injection point that does not change their signatures --
 * the same reasoning magic-link-route.test.ts records.
 */
export function applyRouteEnvironment(databaseUrl: string, schema: string): void {
  Object.assign(process.env, {
    APP_ENV: "test",
    DEPLOYMENT_COMMIT_SHA: "0000000",
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: schema,
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-test",
    STORAGE_ACCESS_KEY_ID: "test-access-key",
    STORAGE_SECRET_ACCESS_KEY: "test-secret-access-key",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    PUBLIC_APP_ORIGIN: "http://localhost:3000",
    SESSION_SECRET: ROUTE_SESSION_SECRET
  });
}

const redirects = new Map<string, string>();
let hooksRegistered = false;

/**
 * Point one bare specifier at a stand-in before any route is loaded.
 *
 * Scoped to the single specifier named, so everything else in the route --
 * the database, the domain rules, the authorization check -- stays real. Must
 * be called at module scope in the test, because Node caches a module the
 * first time a route imports it.
 */
export function registerModuleRedirect(specifier: string, moduleUrl: string): void {
  assert.equal(
    hooksRegistered,
    false,
    `registerModuleRedirect("${specifier}") ran after a route was already loaded; the redirect would not apply`
  );
  redirects.set(specifier, moduleUrl);
}

/**
 * apps/web imports sibling modules extensionless (`from "../../lib/session"`)
 * and package subpaths through Next's bundler (`next/server`). Plain Node ESM
 * resolves neither. The retry adds an extension only after the bare specifier
 * has already failed, so it never shadows something Node could resolve itself;
 * rewriting production import specifiers to suit a test would change how Next
 * builds the app.
 */
function registerRouteResolution(): void {
  moduleHooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      const redirected = redirects.get(specifier);
      if (redirected !== undefined) {
        return { url: redirected, shortCircuit: true };
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (/\.[cm]?[jt]sx?$/u.test(specifier)) {
          throw error;
        }
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

export type RouteHandler = (request: unknown, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/**
 * Imported through a runtime-built specifier rather than a static import.
 *
 * A static `import ".../route.ts"` would pull apps/web into
 * tests/tsconfig.json, which typechecks with module NodeNext; apps/web has no
 * `"type": "module"`, so every route file is then read as CommonJS and its ESM
 * syntax fails with TS1295. Node still executes the genuine handler, so this
 * remains a route-level test.
 *
 * Returns undefined when the route exports no such verb, which is itself
 * assertable: "there is no PATCH on this endpoint" needs no source-text match.
 */
export async function loadRouteHandler(route: string, method: string): Promise<RouteHandler | undefined> {
  if (!hooksRegistered) {
    registerRouteResolution();
    hooksRegistered = true;
  }
  const specifier = new URL(`../../apps/web/src/app/api/${route}/route.ts`, import.meta.url).href;
  const module = (await import(specifier)) as Record<string, unknown>;
  const handler = module[method];
  return typeof handler === "function" ? (handler as RouteHandler) : undefined;
}

/** The exported HTTP verbs of a route, for asserting that a verb is absent. */
export async function loadRouteMethods(route: string): Promise<readonly string[]> {
  if (!hooksRegistered) {
    registerRouteResolution();
    hooksRegistered = true;
  }
  const specifier = new URL(`../../apps/web/src/app/api/${route}/route.ts`, import.meta.url).href;
  const module = (await import(specifier)) as Record<string, unknown>;
  return Object.keys(module)
    .filter((key) => /^[A-Z]+$/u.test(key) && typeof module[key] === "function")
    .sort();
}

/**
 * The genuine NextRequest, loaded from apps/web's own installed Next.
 *
 * `readSessionUserId` reads `request.cookies.get(...)`, which is Next's API
 * and not the WHATWG Request's. Hand-rolling a `cookies` object would fake the
 * exact surface every handler authenticates through, so the real class is used
 * and only its module path is resolved by hand: `next` is installed under
 * apps/web, which a test at the repository root cannot reach by bare specifier.
 */
const nextServerUrl = new URL("../../apps/web/node_modules/next/server.js", import.meta.url).href;
const { NextRequest } = (await import(nextServerUrl)) as {
  NextRequest: new (url: string, init?: RequestInit) => Request;
};

/** Substitute `[segment]` templates, failing loudly rather than requesting a literal "[roleId]". */
function fillRoute(route: string, params: Readonly<Record<string, string>>): string {
  return route.replace(/\[([^\]]+)\]/gu, (_match, name: string) => {
    const value = params[name];
    assert.ok(value !== undefined, `the route "${route}" has a [${name}] segment and no value was given for it`);
    return encodeURIComponent(value);
  });
}

/** Build the request a handler would receive, session cookie and all. */
export function routeRequest(input: RouteRequest, sessionUserId: string | undefined): Request {
  const path = fillRoute(input.route, input.params ?? {});
  const url = new URL(`http://localhost:3000/api/${path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { ...input.headers };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (input.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }
  if (sessionUserId !== undefined) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      createSessionToken(sessionUserId, ROUTE_SESSION_SECRET)
    )}`;
  }
  return new NextRequest(url.href, {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  });
}

/**
 * Provision, run, tear down.
 *
 * Teardown is in a `finally` so a failing assertion still drops the schema;
 * each run's name is unique, so a leak costs a stale schema rather than a
 * collision with the next run.
 */
export async function withApiRouteHarness(
  run: (harness: RouteHarness) => Promise<void>,
  options: { readonly criterionId?: string } = {}
): Promise<void> {
  const databaseUrl = requireRouteDatabase();
  const probe = await provisionApiRouteSchema(databaseUrl, options);
  try {
    applyRouteEnvironment(databaseUrl, probe.schema);

    const userId = (actor: Exclude<RouteActor, "anonymous">): string =>
      actor === "outsider" ? probe.outsider.userId : probe.members[actor].userId;

    await run({
      probe,
      databaseUrl,
      userId,
      async request(input: RouteRequest): Promise<Response> {
        const handler = await loadRouteHandler(input.route, input.method);
        assert.ok(handler !== undefined, `apps/web/src/app/api/${input.route}/route.ts exports no ${input.method}`);
        const request = routeRequest(input, input.as === "anonymous" ? undefined : userId(input.as));
        return handler(request, { params: Promise.resolve({ ...input.params }) });
      },
      async rows<TRow extends Record<string, unknown>>(
        sql: string,
        parameters: readonly unknown[] = []
      ): Promise<readonly TRow[]> {
        return readProbeRows<TRow>(databaseUrl, probe.schema, sql, parameters);
      }
    });
  } finally {
    await dropProbeSchema(databaseUrl, probe.schema);
  }
}
