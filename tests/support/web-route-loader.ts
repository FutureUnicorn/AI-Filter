import moduleHooks from "node:module";

/**
 * Loads a real apps/web route handler into a Node test process.
 *
 * Two problems stand between `node --test` and a route file, and both are
 * solved here rather than by changing how the app is built:
 *
 * 1. apps/web imports sibling modules extensionless (`from
 *    "../../../lib/session"`) and package subpaths Next resolves through
 *    its bundler (`next/server`). Node ESM resolves neither. The hook
 *    retries with `.ts` and then `.js`, and only after the bare specifier
 *    has already failed, so it can never shadow something Node could
 *    resolve on its own.
 *
 * 2. A static `import ".../route.ts"` would pull apps/web into
 *    tests/tsconfig.json, which typechecks with module NodeNext; apps/web
 *    has no `"type": "module"`, so every route file would be read as
 *    CommonJS and fail with TS1295. A runtime-built specifier keeps the
 *    typechecker out of apps/web while Node still executes the genuine
 *    shipped handler.
 *
 * This is the shared form of the hook that magic-link-route.test.ts and
 * file-intake-route-errors.test.ts each carried inline. They differed only
 * in whether they also redirected `@signal-audit/ingestion` to a stub,
 * which is what `redirects` covers.
 */

/**
 * The redirect map the hook was registered with, kept so a later call
 * passing a *different* one is an error rather than a silent no-op.
 *
 * Review #88, REV-004: the previous version returned early once registered,
 * so the second and later calls' `redirects` were discarded. The doc comment
 * said to pass it on the first call and nothing enforced it, which is the
 * shape of trap that costs an afternoon: a future test file loading one
 * route without a redirect and a second with the storage stub would silently
 * get the real package, and the failure would surface as a confusing storage
 * error rather than as "you passed a redirect too late".
 */
let registeredRedirects: Readonly<Record<string, string>> | undefined;

/**
 * The shape every route module shares: named method exports returning a
 * Response.
 *
 * Parameters are `never[]` rather than spelled out because the callers
 * genuinely differ -- a dynamic segment's handler takes Next's route
 * context as a second argument and a static one does not -- and each test
 * declares the signature it actually calls. This constraint exists to
 * catch a caller naming a method the route does not export, not to
 * restate the argument list in a second place.
 */
export interface WebRouteModule {
  GET?(...args: never[]): Promise<Response>;
  POST?(...args: never[]): Promise<Response>;
}

/**
 * Registers the resolution hook once per process.
 *
 * `redirects` maps a bare specifier to an absolute module URL, for the
 * one boundary a route-level test cannot have for real (object storage).
 * It must be passed on the first call in a process, because Node's module
 * hooks are global and already-resolved specifiers are cached.
 */
export function registerWebRouteResolution(redirects: Readonly<Record<string, string>> = {}): void {
  if (registeredRedirects !== undefined) {
    // Node's module hooks are global and resolved specifiers are cached, so a
    // second registration could not take effect anyway. Refusing a differing
    // map turns that from a silent wrong answer into a named one; an
    // identical map is the ordinary case (file-intake-route-errors.test.ts
    // passes its redirect on every call) and is accepted.
    const before = JSON.stringify(registeredRedirects);
    const now = JSON.stringify(redirects);
    if (before !== now) {
      throw new Error(
        `web-route-loader was already registered with a different redirect map, and module hooks cannot be ` +
          `re-registered: the second map would be silently ignored. Pass the same redirects on every call in ` +
          `a process.\n  registered: ${before}\n  attempted:  ${now}`
      );
    }
    return;
  }
  registeredRedirects = redirects;
  // A Map, for the reason auth-codes.ts is one: indexing a plain object with
  // a value that did not come from it is not a closed lookup. A module
  // specifier equal to `constructor` is not realistic, but the argument the
  // rest of this branch makes applies here too.
  const redirectsBySpecifier = new Map(Object.entries(redirects));
  moduleHooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      const redirect = redirectsBySpecifier.get(specifier);
      if (redirect !== undefined) {
        return { url: redirect, shortCircuit: true };
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

/**
 * `baseUrl` is the calling test's `import.meta.url`, so route paths stay
 * relative to the test that names them rather than to this file.
 */
export async function loadWebRoute<T extends WebRouteModule>(
  baseUrl: string,
  relativePath: string,
  redirects?: Readonly<Record<string, string>>
): Promise<T> {
  registerWebRouteResolution(redirects);
  return (await import(new URL(relativePath, baseUrl).href)) as T;
}
