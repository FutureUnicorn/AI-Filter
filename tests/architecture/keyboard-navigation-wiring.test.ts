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

// ---- REV-001 ----
//
// The original review was right: the hook moved an index and the pages
// drew an outline, and nothing ever touched the DOM. What a browser
// would prove cannot be proved here, but the wiring that has to exist
// for it to work can be, and it is exactly the wiring a later refactor
// would drop without any test noticing.

test("the hook reveals the selected element rather than only re-rendering", () => {
  // Matched on the call, not the name: a comment mentioning the helper
  // would otherwise satisfy this.
  const callIndex = hook.indexOf("revealReviewItem(");
  assert.ok(
    callIndex > 0,
    "moving the index must move the reviewer: an outline below the fold is invisible"
  );
  // Delegated, not reimplemented, for the same reason every binding is:
  // the reveal rules are tested in tests/unit and a second copy here
  // would not be.
  assert.doesNotMatch(
    hook,
    /\.focus\(|\.scrollIntoView\(/u,
    "focus handling belongs in review-focus.ts, where node --test can reach it"
  );
  const call = hook.slice(callIndex, hook.indexOf(");", callIndex));
  // A hard-coded count would pass the live counter's name but not its
  // value, and would reveal on the very first render.
  assert.match(
    call,
    /movementCount(?!\s*:\s*\d)/u,
    "the reveal must be keyed on a keypress, or the first render steals focus from wherever the reviewer left it"
  );
});

test("both review surfaces hand their navigable element to the hook", () => {
  for (const page of [
    "apps/web/src/app/roles/[roleId]/applications/page.tsx",
    "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx"
  ]) {
    const source = readFileSync(join(repositoryRoot, page), "utf8");
    // The index variable is named per surface (REV-002 renamed the
    // evidence card's to cardIndex), so the identifier is not pinned here,
    // only that the element reaches the hook.
    assert.match(
      source,
      /ref=\{registerItem\([A-Za-z]+\)\}/u,
      `${page} registers no element, so the hook has nothing to focus or scroll to`
    );
    // Roving tabindex. Without a tabindex the row cannot take focus at
    // all, so focus() is a no-op and the whole repair is decorative.
    assert.match(
      source,
      /tabIndex=\{[A-Za-z]+ === focusedIndex \? 0 : -1\}/u,
      `${page} must put exactly the selected item in the tab order`
    );
    assert.ok(
      !source.includes("aria-selected="),
      `${page} must not use aria-selected: it is unsupported outside a grid, so it announced nothing`
    );
  }
});

// ---- REV-002 ----
//
// `s` stored the focused card index and the JSX compared it against the
// citation index, which shadowed it. Card 0 revealed the first citation
// of every card; card 2 revealed nothing unless some card happened to
// have three citations.
//
// The repair is not the rename. The revealed value is now the criterion
// id, so the wrong comparison is a type error rather than a convention,
// and tsc in the gate is what enforces it. These two assertions cover
// what tsc cannot: that the comparison was not simply moved back onto a
// position, and that the shadowing which made the mistake invisible
// cannot reappear in this file.
//
// Said plainly: nothing here renders the component, so "every citation
// on the selected card shows its context" is guaranteed by the compiler
// and by the shape of the code, not by an assertion about output. That
// would need jsdom, which this repository does not have.

test("the source reveal is scoped to the card, by identity rather than by position", () => {
  const page = readFileSync(
    join(repositoryRoot, "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx"),
    "utf8"
  );
  assert.match(
    page,
    /revealedCriterion === card\.criterionId/u,
    "the reveal must be gated on the focused card's identity, not on any index"
  );
  assert.ok(
    !page.includes("revealedSource"),
    "a revealed index is comparable to a citation index and TypeScript cannot object"
  );
});

test("no loop in the evidence card page is named index, because two of them nest", () => {
  // The cards map and the citations map are nested, so a parameter named
  // `index` in both means the inner one silently wins. Distinct names are
  // what make the comparison readable at the point it is written.
  const page = readFileSync(
    join(repositoryRoot, "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx"),
    "utf8"
  );
  assert.doesNotMatch(
    page,
    /\.map\(\([A-Za-z]+, index\)/u,
    "name it cardIndex or citationIndex: a shared name is what hid REV-002"
  );
});
