/**
 * Runs once before the server accepts its first request (Next.js calls
 * `register` and waits for it), which is the only place a missing web-only
 * secret can be turned into a boot failure rather than a request failure.
 *
 * Review #83, REV-003: SESSION_SECRET is read inside readSessionSecret at
 * request time and is absent from every env template. A deployment following
 * .env.example therefore booted, passed the environment health check, and then
 * threw an unhandled error on every authenticated request, with no request id
 * and nothing in the structured log stream. "Healthy but answering 500 to
 * everyone" is the worst shape a configuration error can take, because the
 * thing that is supposed to detect it reports success.
 *
 * Deliberately not solved by adding SESSION_SECRET to packages/config's shared
 * schema: apps/worker loads that same schema and has no sessions to sign, so
 * requiring it there would make the worker fail to boot over a secret it never
 * reads. This keeps the requirement where the requirement actually is.
 */
export async function register(): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set to a string of at least 32 characters before the web server starts. " +
        "Every authenticated request signs and verifies a session cookie with it, so without it the server " +
        "would boot and then fail every request. See .env.example."
    );
  }
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeWebTelemetry } = await import("./lib/observability");
    initializeWebTelemetry();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { captureServerError, operationForRoute } = await import("./lib/observability");
  captureServerError(error, { operation: operationForRoute(context.routePath) });
};
import type { Instrumentation } from "next";
