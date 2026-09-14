import assert from "node:assert/strict";
import test from "node:test";

import { ObjectTooLargeError, readCappedStream } from "../../packages/ingestion/src/index.ts";

/**
 * PR #83 review, P1: the size limit was enforced after the whole untrusted
 * object had already been buffered.
 *
 * `fetchObjectBytes` used `transformToByteArray()`, which allocates
 * everything before `evaluateFileValidation` ever sees
 * `MAX_FILE_UPLOAD_BYTES`. The signed PUT carries no content-length
 * constraint, so anyone holding a valid upload URL could make every
 * validator buffer an arbitrarily large object. The limit was being applied
 * after the harm it exists to prevent.
 *
 * Scope stated honestly: CI provides Postgres but no object store, so an
 * end-to-end oversized-upload test against real storage cannot run here.
 * What is tested is the enforcement that actually bounds memory. The
 * `HeadObject` pre-check in `fetchObjectBytes` avoids the transfer entirely
 * when the store reports a length, but it cannot be the guarantee, because
 * `ContentLength` may be absent -- which is exactly why the streaming cap
 * exists underneath it.
 */

async function* chunks(count: number, size: number): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < count; index += 1) {
    yield new Uint8Array(size);
  }
}

test("a stream under the cap is read normally", async () => {
  const buffer = await readCappedStream(chunks(4, 256), 4096, "under.pdf");
  assert.equal(buffer.length, 1024);
});

test("a stream exactly at the cap is accepted, not rejected off by one", async () => {
  const buffer = await readCappedStream(chunks(4, 256), 1024, "exact.pdf");
  assert.equal(buffer.length, 1024);
});

test("a stream over the cap is refused", async () => {
  await assert.rejects(
    () => readCappedStream(chunks(5, 256), 1024, "over.pdf"),
    (error: unknown) => {
      assert.ok(error instanceof ObjectTooLargeError, "must be the typed error, so a caller can reject rather than 500");
      assert.equal(error.limitBytes, 1024);
      assert.equal(error.key, "over.pdf");
      return true;
    }
  );
});

test("reading stops at the chunk that crosses the cap, so memory stays bounded", async () => {
  // The property that matters. A stream declaring far more than the cap must
  // not be drained: peak memory has to stay within one chunk of the limit
  // however much the sender intended to send. Counting how many chunks were
  // pulled is what distinguishes a real early abort from a check that runs
  // after buffering everything.
  let pulled = 0;
  async function* hostile(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < 10_000; index += 1) {
      pulled += 1;
      yield new Uint8Array(1024);
    }
  }

  await assert.rejects(() => readCappedStream(hostile(), 4096, "hostile.pdf"), ObjectTooLargeError);

  // 4 chunks fill the cap, the 5th crosses it and aborts. Anything close to
  // 10,000 would mean the whole object was buffered before the check.
  assert.equal(pulled, 5, `expected the read to abort after 5 chunks, pulled ${pulled}`);
});
