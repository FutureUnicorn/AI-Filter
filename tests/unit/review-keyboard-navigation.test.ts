import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_SHORTCUTS,
  nextReviewIndex,
  resolveReviewKeyAction,
  revealedCriterionId
} from "../../packages/domain/src/index.ts";
import type { ReviewKeyAction } from "../../packages/domain/src/index.ts";

import { revealReviewItem } from "../../apps/web/src/lib/review-focus.ts";
import type { RevealableItem } from "../../apps/web/src/lib/review-focus.ts";

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

// ---- REV-001: a moved index that never reaches the DOM ----
//
// The first cut of AF-53 moved React state and drew an outline. An
// outline is invisible below the fold, so in the queue this feature
// exists for -- hundreds of applications -- `j` walked the selection
// off-screen and `Enter` opened a candidate the reviewer never saw.
// These cover the part of the repair that is decidable without a
// browser: whether an item is revealed at all, which one, and how.

interface RecordingItem extends RevealableItem {
  readonly calls: readonly string[];
}

function recordingItem(): RecordingItem {
  const calls: string[] = [];
  return {
    calls,
    focus(options) {
      calls.push(`focus ${JSON.stringify(options)}`);
    },
    scrollIntoView(options) {
      calls.push(`scrollIntoView ${JSON.stringify(options)}`);
    }
  };
}

test("a moved selection is focused and scrolled to, not merely outlined", () => {
  const item = recordingItem();
  const revealed = revealReviewItem(new Map([[1, item]]), { index: 1, movementCount: 1 });

  assert.equal(revealed, true);
  // preventScroll matters: the browser's own focus scroll walks every
  // scrollable ancestor and may centre the row, which throws the rest of
  // the queue off screen on every keypress. "nearest" moves the minimum.
  assert.deepEqual(item.calls, ['focus {"preventScroll":true}', 'scrollIntoView {"block":"nearest"}']);
});

test("only the selected item is revealed", () => {
  const first = recordingItem();
  const second = recordingItem();
  const items = new Map([
    [0, first],
    [1, second]
  ]);

  revealReviewItem(items, { index: 1, movementCount: 4 });

  assert.deepEqual(first.calls, [], "an unselected row must not be focused out from under the reviewer");
  assert.equal(second.calls.length, 2);
});

test("nothing is focused before the reviewer has pressed a navigation key", () => {
  // Selection starts at index 0, so revealing unconditionally would yank
  // focus to the first row the moment the fetch resolves -- discarding
  // wherever the reviewer had put it and cutting off a screen reader
  // mid-announcement. That is a regression introduced by the fix, not by
  // the bug, which is why it is pinned here.
  const item = recordingItem();

  assert.equal(revealReviewItem(new Map([[0, item]]), { index: 0, movementCount: 0 }), false);
  assert.deepEqual(item.calls, []);
});

test("pressing the key again at the end of the list still brings the last item back", () => {
  // The clamp means the index stops changing at the end, but `j` is
  // still a request to see that row, and the reviewer may have scrolled
  // away with the mouse. Revealing on index change alone would do
  // nothing here, so the movement count, not the index, is the trigger.
  const item = recordingItem();
  const items = new Map([[4, item]]);

  assert.equal(revealReviewItem(items, { index: 4, movementCount: 7 }), true);
  assert.equal(revealReviewItem(items, { index: 4, movementCount: 8 }), true);
  assert.equal(item.calls.length, 4);
});

test("an empty list and an item that has not rendered reveal nothing rather than throwing", () => {
  // nextReviewIndex reports -1 for an empty queue, and a row can be
  // unregistered for a frame while the filter re-renders the table.
  assert.equal(revealReviewItem(new Map(), { index: -1, movementCount: 3 }), false);
  assert.equal(revealReviewItem(new Map([[0, recordingItem()]]), { index: 2, movementCount: 3 }), false);
});

// ---- REV-002: `s` revealed the wrong thing ----
//
// The focused CARD index was stored and the JSX compared it against the
// CITATION index, which shadowed it. Card 0 revealed the first citation
// of every card, and selecting card 2 revealed nothing at all unless
// some card happened to have three citations.
//
// The scope decision, stated once: the reveal is card-scoped. The
// published shortcut is "Reveal the source citation for the focused
// card", and j/k/g/G move over cards only. Nothing moves between the
// citations inside a card, so a citation-scoped reveal would target
// something the reviewer cannot select. Which is what the bug did.
//
// So the revealed value is a criterion id, not a position. These cover
// the conversion; the comparison itself is a type error now, and tsc in
// the gate is what proves that half.

test("the focused card is resolved by identity, including a card that is not the first", () => {
  // The reviewer's case from the report: select a later card, press `s`.
  // Returning the criterion at that position is the whole of it, and it
  // must not quietly return the first one or nothing.
  const criteria = ["communication", "system-design", "testing"];

  assert.equal(revealedCriterionId(criteria, 2), "testing");
  assert.equal(revealedCriterionId(criteria, 1), "system-design");
  assert.equal(revealedCriterionId(criteria, 0), "communication");
});

test("no card focused reveals no source, rather than the first card's", () => {
  // nextReviewIndex reports -1 for an empty list, and an index that has
  // run past a list which shrank must not resolve to a neighbour.
  assert.equal(revealedCriterionId(["communication"], -1), undefined);
  assert.equal(revealedCriterionId([], 0), undefined);
  assert.equal(revealedCriterionId(["communication", "testing"], 5), undefined);
});

test("the revealed value is a criterion id, so it cannot be a citation position", () => {
  // The defect was structural: two numbers, one of them shadowed, and
  // nothing in the type system to object. An id is a string, so the
  // comparison that caused this no longer compiles. This asserts the
  // property that makes that true.
  const revealed = revealedCriterionId(["communication", "system-design"], 1);
  assert.equal(typeof revealed, "string");
  assert.notEqual(revealed, 1);
});
