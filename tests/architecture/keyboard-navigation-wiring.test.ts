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
  // REV-003 replaced the keypress counter this used to pin. The reveal
  // is told why the index moved; a hard-coded cause would reveal on the
  // first render and on every refetch.
  assert.match(
    call,
    /\bcause\b(?!\s*:\s*")/u,
    "the reveal must be told the cause of the change, or the first render steals focus from wherever the reviewer left it"
  );
});

// ---- REV-003 ----
//
// The reveal ran in an effect keyed on focusedIndex and inferred "was
// this a keypress" from a counter that stayed non-zero after the first
// `j`. A filter refetch clamps the index to -1 and back to 0, so every
// toggle threw focus from the checkbox onto row 0. tests/unit proves the
// reveal refuses anything but a keypress; these prove the hook actually
// states each cause truthfully, which is the half a refactor would lose
// without a unit test noticing.

function handlerSource(): string {
  const start = hook.indexOf("function handle(");
  const end = hook.indexOf('window.addEventListener("keydown"', start);
  assert.ok(start >= 0 && end > start, "the keydown handler must be locatable");
  return hook.slice(start, end);
}

test("the reveal is not driven by an effect watching the index", () => {
  // An effect sees only the new index, never why it moved, which is the
  // whole defect. The reveal belongs at the change.
  assert.equal(
    hook.split("revealReviewItem(").length - 1,
    1,
    "exactly one reveal call site, inside the select that every index change goes through"
  );
  assert.doesNotMatch(
    hook,
    /\}\s*,\s*\[[^\]]*\bfocusedIndex\b[^\]]*\]\s*\)/u,
    "no effect may depend on focusedIndex: it cannot tell a keypress from a refetch"
  );
  assert.doesNotMatch(
    hook,
    /movementCount|set[A-Z][A-Za-z]*Count\(/u,
    "intent must be stated by the caller, not inferred from a keypress counter"
  );
});

test("only the keydown handler claims a keypress", () => {
  assert.equal(
    hook.split('"keypress"').length - 1,
    1,
    "a second keypress cause is a second path that can move DOM focus"
  );
  assert.match(handlerSource(), /select\(next, "keypress"\)/u, "the key handler must reveal what it moved to");
});

test("the clamp and the focus-follow path both say they are not keypresses", () => {
  // The clamp is what a filter refetch drives; the focus-follow path is
  // what the pages' onFocus calls. Either one revealing is REV-003.
  assert.match(
    hook,
    /select\(nextReviewIndex\("none", focusedIndexRef\.current, itemCount\), "list-changed"\)/u,
    "the clamp must declare itself a list change"
  );
  assert.match(hook, /select\(index, "focus-followed"\)/u, "following focus must not re-focus");
  assert.match(
    hook,
    /setFocusedIndex: followFocus/u,
    "the setter the pages call from onFocus must be the non-revealing one"
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

// ---- REV-005 ----
//
// Shortcuts displayed must reflect wired callbacks, not hard-coded defaults.
// Unwired actions must not swallow keys before returning.

test("unwired actions return before calling preventDefault in the keyboard hook", () => {
  const unhandledGuard = hook.indexOf("!isActionHandled(action");
  const preventIndex = hook.indexOf("event.preventDefault()");
  assert.ok(unhandledGuard >= 0, "the hook must guard unhandled actions");
  assert.ok(
    preventIndex > unhandledGuard,
    "unhandled actions must bail out before preventDefault is called"
  );
});

test("both review surfaces pass filtered shortcuts to ShortcutHelp", () => {
  for (const page of [
    "apps/web/src/app/roles/[roleId]/applications/page.tsx",
    "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx"
  ]) {
    const source = readFileSync(join(repositoryRoot, page), "utf8");
    assert.match(
      source,
      /<ShortcutHelp[^>]*shortcuts=\{shortcuts\}/u,
      `${page} must pass filtered shortcuts to ShortcutHelp`
    );
  }
});

// ---- REV-006 ----
//
// Screen reader announcements for source context require a persistent
// polite live region in the DOM before any reveal occurs, and citations
// must not individually carry aria-live.

test("evidence page has exactly one persistent polite live region outside citation loops", () => {
  const page = readFileSync(
    join(repositoryRoot, "apps/web/src/app/roles/[roleId]/applications/[applicationId]/page.tsx"),
    "utf8"
  );
  assert.equal(
    page.split('aria-live="polite"').length - 1,
    1,
    "evidence page must have exactly one polite live region"
  );
  const liveIndex = page.indexOf('aria-live="polite"');
  const cardMapIndex = page.indexOf("state.cards.cards.map");
  assert.ok(
    liveIndex >= 0 && cardMapIndex > liveIndex,
    "the live region must be mounted persistently before the card list"
  );
  assert.doesNotMatch(
    page.slice(cardMapIndex),
    /aria-live/u,
    "neither card nor citation loops may contain aria-live"
  );
});
