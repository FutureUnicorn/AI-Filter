import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-53. This repository has no jsdom and no testing-library, so the
// event plumbing cannot be exercised. What CAN be checked without a
// browser is that the plumbing delegates to the decision layer instead
// of reimplementing it -- which is the failure mode that would make the
// exhaustive tests in tests/unit meaningless while still passing.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = readFileSync(join(repositoryRoot, "apps/web/src/lib/review-keyboard.ts"), "utf8");

test("the hook decides nothing itself: every binding comes from the domain resolver", () => {
  assert.ok(hook.includes("resolveReviewKeyAction"), "key handling must delegate to the tested resolver");
  assert.ok(hook.includes("nextReviewIndex"), "movement must delegate to the tested clamp");
  // A literal key comparison in the hook is a binding that no unit test
  // covers, because the resolver is where they are all enumerated.
  assert.doesNotMatch(
    hook,
    /event\.key\s*===/u,
    "a key compared directly in the hook is a binding the unit tests cannot see"
  );
});

test("preventDefault is called only for keys the feature actually claims", () => {
  // Calling it unconditionally breaks scrolling, tab order and form
  // submission for every key this feature does not use -- a bigger
  // regression than the one it is meant to fix.
  const guardIndex = hook.indexOf('if (action === "none")');
  const preventIndex = hook.indexOf("event.preventDefault()");
  assert.ok(guardIndex >= 0, "the handler must bail out on an unclaimed key");
  assert.ok(preventIndex > guardIndex, "preventDefault must come after the unclaimed-key return");
});

test("a checkbox is not treated as a text field", () => {
  // AF-47's state filters are checkboxes. Treating them as text would
  // silently disable navigation for anyone who tabbed into the filters.
  assert.ok(hook.includes('"checkbox"'), "checkbox inputs must be excluded from the editing-text check");
});

test("both review surfaces use the shared hook rather than their own listeners", () => {
  for (const page of [
    "apps/web/src/app/roles/[roleId]/applications/page.tsx",
    "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx"
  ]) {
    const source = readFileSync(join(repositoryRoot, page), "utf8");
    assert.ok(source.includes("useReviewKeyboard"), `${page} must use the shared hook`);
    assert.doesNotMatch(
      source,
      /addEventListener\(\s*["']keydown["']/u,
      `${page} must not attach its own keydown listener`
    );
    assert.ok(source.includes("ShortcutHelp"), `${page} must expose the shortcut list`);
  }
});
