import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_SHORTCUTS,
  nextReviewIndex,
  resolveReviewKeyAction
} from "../../packages/domain/src/index.ts";
import type { ReviewKeyAction } from "../../packages/domain/src/index.ts";

// AF-53: "Recruiters reviewing hundreds of applications need
// keyboard-driven navigation between cards and source context, not
// mouse-only review."

test("typing in a text field claims no key at all", () => {
  // The failure this prevents is specific: AF-50 requires a rationale on
  // every correction, so a shortcut firing mid-sentence eats the one
  // field the system insists on. Every binding must be suppressed, not
  // just the letters.
  for (const key of ["j", "k", "g", "G", "s", "?", "Enter", "ArrowDown", "ArrowUp", "Home", "End"]) {
    assert.equal(
      resolveReviewKeyAction({ key, editingText: true }),
      "none",
      `${key} must not be claimed while the user is typing`
    );
  }
});

test("a modified key is left to the browser and the operating system", () => {
  // Taking Cmd+K or Ctrl+F makes an app harder to drive from the
  // keyboard, which inverts this ticket.
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
    for (const key of ["j", "k", "Enter", "ArrowDown"]) {
      assert.equal(
        resolveReviewKeyAction({ key, [modifier]: true }),
        "none",
        `${modifier}+${key} belongs to the platform`
      );
    }
  }
});

test("Shift is deliberately NOT refused, because two bindings need it", () => {
  // `?` and `G` require Shift on most layouts. Refusing Shift wholesale
  // would silently disable the help binding and the jump-to-last one --
  // the kind of over-correction that looks safe and removes a feature.
  assert.equal(resolveReviewKeyAction({ key: "?" }), "help");
  assert.equal(resolveReviewKeyAction({ key: "G" }), "last");
});

test("every published shortcut resolves to a real action", () => {
  // Without this the help panel can list a key nothing implements --
  // the most annoying possible bug in a discoverability feature.
  const displayed: Readonly<Record<string, string>> = { "↓": "ArrowDown", "↑": "ArrowUp" };
  for (const shortcut of REVIEW_SHORTCUTS) {
    for (const label of shortcut.keys) {
      const key = displayed[label] ?? label;
      assert.notEqual(
        resolveReviewKeyAction({ key }),
        "none",
        `the help panel lists ${label} but nothing handles it`
      );
    }
  }
});

test("every action the resolver can return is described in the published list", () => {
  // And the other direction: an implemented binding nobody is told about
  // is a mouse-only interface with a secret.
  const actions = new Set<ReviewKeyAction>();
  for (const key of ["j", "k", "g", "G", "Enter", "s", "?", "ArrowDown", "ArrowUp", "Home", "End"]) {
    actions.add(resolveReviewKeyAction({ key }));
  }
  actions.delete("none");
  assert.equal(actions.size, REVIEW_SHORTCUTS.length, "the shortcut list and the resolver have drifted apart");
});

test("an unbound key is left alone", () => {
  for (const key of ["a", "z", "Tab", "Escape", "F5", " "]) {
    assert.equal(resolveReviewKeyAction({ key }), "none");
  }
});

test("navigation clamps at both ends and never wraps", () => {
  // Wrapping re-presents already-reviewed candidates as new and gives no
  // signal the list ended -- the wrong failure in a tool whose purpose
  // is that a human actually saw each one.
  assert.equal(nextReviewIndex("next", 4, 5), 4, "the end must hold, not loop to the top");
  assert.equal(nextReviewIndex("previous", 0, 5), 0, "the start must hold, not loop to the bottom");
  assert.equal(nextReviewIndex("next", 0, 5), 1);
  assert.equal(nextReviewIndex("previous", 3, 5), 2);
});

test("first and last jump regardless of where focus is", () => {
  assert.equal(nextReviewIndex("first", 4, 5), 0);
  assert.equal(nextReviewIndex("last", 0, 5), 4);
});

test("actions that are not movement leave focus exactly where it was", () => {
  for (const action of ["open", "reveal-source", "help", "none"] as const) {
    assert.equal(nextReviewIndex(action, 2, 5), 2, `${action} must not move focus`);
  }
});

test("an empty list has no focus rather than a focus on nothing", () => {
  // Returning 0 here would point at an item that does not exist, and the
  // component would render a highlight on empty space.
  for (const action of ["next", "previous", "first", "last", "none"] as const) {
    assert.equal(nextReviewIndex(action, 0, 0), -1, `${action} on an empty list must report no focus`);
  }
});

test("an out-of-range index is brought back into range rather than trusted", () => {
  // A list that shrinks under the cursor -- a filter applied, an item
  // removed -- must not leave focus pointing past the end.
  assert.equal(nextReviewIndex("next", 99, 3), 2);
  assert.equal(nextReviewIndex("previous", -99, 3), 0);
  assert.equal(nextReviewIndex("none", 42, 3), 2);
});

test("a single-item list is stable under every movement", () => {
  for (const action of ["next", "previous", "first", "last"] as const) {
    assert.equal(nextReviewIndex(action, 0, 1), 0);
  }
});
