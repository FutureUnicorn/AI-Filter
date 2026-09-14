import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ObjectChangedError, fetchValidatedObjectBytes } from "../../packages/ingestion/src/index.ts";

/**
 * PR #83 review, P1: validation did not make the uploaded object immutable.
 *
 * Completing an intake does not revoke the presigned PUT. The URL stays
 * writable for the rest of its 15-minute TTL, so its holder could upload
 * benign bytes, let them validate, then overwrite the same key. Extract-text
 * and finalize re-fetched the key and consumed the replacement without ever
 * comparing it to `sha256_hash`, so MIME, size and quarantine validation were
 * all bypassed by a second PUT.
 *
 * Every post-validation read is now bound to the validated digest.
 *
 * Two things stated plainly rather than implied:
 *
 *  - This DETECTS the substitution; it does not prevent the write. The
 *    overwrite still lands in the bucket, but nothing downstream processes
 *    it. Prevention needs bucket versioning with a pinned VersionId, which is
 *    infrastructure this change does not add.
 *  - CI runs Postgres but no object store, so the S3 round trip cannot be
 *    exercised here. The binding itself is what matters and is tested
 *    directly against a fake store, driven through the real
 *    `fetchValidatedObjectBytes`.
 */

const VALIDATED = Buffer.from("candidate,email\nCasey,casey@acme.test\n");
const OVERWRITTEN = Buffer.from("candidate,email\nAttacker,attacker@evil.test\n");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * A storage double standing in for the bucket. Only the two operations
 * `fetchObjectBytes` performs are modelled: HeadObject for the length and
 * GetObject for a stream. `put` is the overwrite an attacker performs with
 * the still-valid presigned URL.
 */
function fakeStore(initial: Buffer): {
  readonly options: Parameters<typeof fetchValidatedObjectBytes>[0];
  put(bytes: Buffer): void;
} {
  let current = initial;
  const options = {
    endpoint: "http://fake",
    region: "us-east-1",
    bucket: "fake",
    accessKeyId: "k",
    secretAccessKey: "s",
    forcePathStyle: true,
    // Test-only seam: when present, fetchObjectBytes reads through this
    // instead of constructing an S3 client. Keeps the assertion on the real
    // verification path rather than a reimplementation of it.
    __testReader: {
      head: (): { ContentLength: number } => ({ ContentLength: current.length }),
      get: async function* (): AsyncGenerator<Uint8Array> {
        yield new Uint8Array(current);
      }
    }
  } as unknown as Parameters<typeof fetchValidatedObjectBytes>[0];
  return {
    options,
    put(bytes: Buffer): void {
      current = bytes;
    }
  };
}

test("bytes matching the validated hash are returned", async () => {
  const store = fakeStore(VALIDATED);
  const bytes = await fetchValidatedObjectBytes(store.options, "intake/a.csv", sha256(VALIDATED));
  assert.equal(bytes.toString(), VALIDATED.toString());
});

test("an object overwritten after validation is refused, not processed", async () => {
  const store = fakeStore(VALIDATED);
  const validatedHash = sha256(VALIDATED);

  // Validation approved these bytes.
  await fetchValidatedObjectBytes(store.options, "intake/a.csv", validatedHash);

  // The presigned PUT is still live, so the holder replaces them.
  store.put(OVERWRITTEN);

  // Every later read must now refuse. Before this change, extract-text and
  // finalize consumed the replacement as though it had been validated.
  await assert.rejects(
    () => fetchValidatedObjectBytes(store.options, "intake/a.csv", validatedHash),
    (error: unknown) => {
      assert.ok(error instanceof ObjectChangedError, "must be the typed error so a caller can answer conflict, not 500");
      assert.equal(error.expectedSha256, validatedHash);
      assert.equal(error.actualSha256, sha256(OVERWRITTEN));
      return true;
    }
  );
});

test("a same-length overwrite is still caught", async () => {
  // Size alone cannot be the check. An attacker who matches the byte count
  // would pass any length comparison, so the digest is what has to be
  // compared; this pins that the implementation does not shortcut on length.
  const sameLength = Buffer.from(VALIDATED.toString().replace("Casey", "Craig"));
  assert.equal(sameLength.length, VALIDATED.length, "fixture must be the same length to be meaningful");

  const store = fakeStore(VALIDATED);
  store.put(sameLength);
  await assert.rejects(
    () => fetchValidatedObjectBytes(store.options, "intake/a.csv", sha256(VALIDATED)),
    ObjectChangedError
  );
});
