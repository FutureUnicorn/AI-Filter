import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeCsvText } from "../../packages/ingestion/src/index.ts";

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
