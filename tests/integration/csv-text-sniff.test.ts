import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeCsvText } from "../../packages/ingestion/src/index.ts";

// Integration, not unit, for a mechanical reason rather than a
// conceptual one: looksLikeCsvText is pure, but importing the module it
// lives in pulls in packages/ingestion's `@signal-audit/domain` import,
// which resolves through node_modules to that package's built dist. CI's
// Unit job checks out fresh and runs `pnpm test:unit` with no build step
// at all, so there is no dist and the whole file fails to load:
//
//   Cannot find module '.../@signal-audit/domain/dist/index.js'
//     imported from packages/ingestion/src/index.ts
//
// A combined local `pnpm check` hides this, because typecheck builds the
// packages as a side effect before the tests run. test:integration runs
// build:packages first, which is exactly what this needs.

test("a real CSV's bytes look like CSV text", () => {
  assert.equal(looksLikeCsvText(Buffer.from("Full Name,Email\nAda,ada@example.com\n", "utf8")), true);
});

test("a buffer with a null byte is rejected as binary, not text", () => {
  assert.equal(looksLikeCsvText(Buffer.from([0x41, 0x00, 0x42])), false);
});

test("invalid UTF-8 is rejected", () => {
  assert.equal(looksLikeCsvText(Buffer.from([0xff, 0xfe, 0xfd])), false);
});

test("an empty buffer is rejected", () => {
  assert.equal(looksLikeCsvText(Buffer.alloc(0)), false);
});

test("real PDF magic bytes are rejected", () => {
  assert.equal(looksLikeCsvText(Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary")), false);
});
