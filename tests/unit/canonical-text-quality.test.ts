import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCanonicalTextQuality } from "../../packages/domain/src/index.ts";

test("no pages at all is empty", () => {
  assert.equal(evaluateCanonicalTextQuality([]), "empty");
});

test("every page with real text is full", () => {
  const pages = [{ characterCount: 500 }, { characterCount: 800 }];
  assert.equal(evaluateCanonicalTextQuality(pages), "full");
});

test("every page with no meaningful text is empty, not partial", () => {
  const pages = [{ characterCount: 0 }, { characterCount: 3 }];
  assert.equal(evaluateCanonicalTextQuality(pages), "empty");
});

test("a mix of meaningful and empty pages is partial", () => {
  const pages = [{ characterCount: 500 }, { characterCount: 0 }];
  assert.equal(evaluateCanonicalTextQuality(pages), "partial");
});

test("a single page right at the meaningful-character threshold counts as meaningful", () => {
  assert.equal(evaluateCanonicalTextQuality([{ characterCount: 20 }]), "full");
  assert.equal(evaluateCanonicalTextQuality([{ characterCount: 19 }]), "empty");
});
