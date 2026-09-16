/**
 * A stand-in for `@signal-audit/ingestion` that keeps every real export and
 * replaces only the two functions that touch object storage.
 *
 * Why a stub rather than a real bucket: CI provides Postgres and no object
 * store, so the storage boundary is the one piece a route-level test cannot
 * have for real. Everything else in the request stays genuine, including the
 * handler, the contracts, the authorization check and the database.
 *
 * What this deliberately does NOT fake: the errors. `ObjectTooLargeError` and
 * `ObjectChangedError` are re-exported from the real module and thrown as
 * instances of it, so the `instanceof` checks in the routes are the real ones.
 * A hand-rolled look-alike would pass the test and fail in production.
 */
import {
  ObjectChangedError,
  ObjectTooLargeError,
  type SniffedFile
} from "../../packages/ingestion/src/index.ts";

export * from "../../packages/ingestion/src/index.ts";

export type StorageBehaviour =
  | { readonly kind: "sniffed"; readonly sniffed: SniffedFile }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large"; readonly limitBytes: number; readonly observedBytes?: number }
  /** `expected` is not carried here: the stub reports back whatever hash the
   * route actually asked it to verify, so a route passing the wrong one is
   * visible rather than papered over by a fixture. */
  | { readonly kind: "changed"; readonly actual: string };

/** Mutable so a test can change the boundary's behaviour between calls
 * without reloading the route module, which Node's ESM cache would reuse. */
export const storageControl: { behaviour: StorageBehaviour } = {
  behaviour: { kind: "too_large", limitBytes: 1 }
};

function raise(key: string, expectedSha256: string): never {
  const behaviour = storageControl.behaviour;
  if (behaviour.kind === "too_large") {
    throw new ObjectTooLargeError(key, behaviour.limitBytes, behaviour.observedBytes);
  }
  if (behaviour.kind === "changed") {
    throw new ObjectChangedError(key, expectedSha256, behaviour.actual);
  }
  throw new Error(`storage stub has no read configured for ${key}`);
}

export async function sniffUploadedFile(_options: unknown, key: string): Promise<SniffedFile> {
  const behaviour = storageControl.behaviour;
  if (behaviour.kind === "sniffed") {
    return behaviour.sniffed;
  }
  // The sniffer runs before anything has been validated, so there is no
  // recorded hash to check against yet.
  return raise(key, "");
}

export async function fetchValidatedObjectBytes(
  _options: unknown,
  key: string,
  expectedSha256: string
): Promise<Uint8Array> {
  const behaviour = storageControl.behaviour;
  if (behaviour.kind === "bytes") {
    return behaviour.bytes;
  }
  return raise(key, expectedSha256);
}
