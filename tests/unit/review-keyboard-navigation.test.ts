import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_SHORTCUTS,
  nextReviewIndex,
  resolveReviewKeyAction,
  revealedCriterionId
} from "../../apps/web/src/lib/review-keys.ts";
import type { ReviewKeyAction } from "../../apps/web/src/lib/review-keys.ts";

import {
  buildSourceContextAnnouncement,
  filterSupportedShortcuts,
  isActionHandled,
  revealReviewItem
} from "../../apps/web/src/lib/review-focus.ts";
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
  const revealed = revealReviewItem(new Map([[1, item]]), { index: 1, cause: "keypress" });

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

  revealReviewItem(items, { index: 1, cause: "keypress" });

  assert.deepEqual(first.calls, [], "an unselected row must not be focused out from under the reviewer");
  assert.equal(second.calls.length, 2);
});

test("nothing is focused before the reviewer has pressed a navigation key", () => {
  // Selection starts at index 0, so revealing unconditionally would yank
  // focus to the first row the moment the fetch resolves -- discarding
  // wherever the reviewer had put it and cutting off a screen reader
  // mid-announcement. That is a regression introduced by the fix, not by
  // the bug, which is why it is pinned here. The first load is a list
  // change: the clamp takes the index from -1 to 0.
  const item = recordingItem();

  assert.equal(revealReviewItem(new Map([[0, item]]), { index: 0, cause: "list-changed" }), false);
  assert.deepEqual(item.calls, []);
});

test("pressing the key again at the end of the list still brings the last item back", () => {
  // The clamp means the index stops changing at the end, but `j` is
  // still a request to see that row, and the reviewer may have scrolled
  // away with the mouse. Revealing on index change alone would do
  // nothing here, so the keypress, not the index, is the trigger.
  const item = recordingItem();
  const items = new Map([[4, item]]);

  assert.equal(revealReviewItem(items, { index: 4, cause: "keypress" }), true);
  assert.equal(revealReviewItem(items, { index: 4, cause: "keypress" }), true);
  assert.equal(item.calls.length, 4);
});

test("an empty list and an item that has not rendered reveal nothing rather than throwing", () => {
  // nextReviewIndex reports -1 for an empty queue, and a row can be
  // unregistered for a frame while the filter re-renders the table.
  assert.equal(revealReviewItem(new Map(), { index: -1, cause: "keypress" }), false);
  assert.equal(revealReviewItem(new Map([[0, recordingItem()]]), { index: 2, cause: "keypress" }), false);
});

// ---- REV-003: a filter refetch pulled focus onto row 0 ----
//
// The reveal ran in an effect on every focusedIndex change once any
// navigation key had ever been pressed. Toggling an AF-47 filter empties
// the queue while it refetches, so the clamp moves the index to -1 and,
// when the fetch resolves, back to 0. The effect saw an index change and
// a non-zero keypress counter and focused row 0, throwing the reviewer
// out of the filter fieldset on every toggle. The cause of the change is
// now part of the request, so these replay that sequence.

test("a filter refetch after an earlier keypress moves no focus and scrolls nothing", () => {
  const first = recordingItem();
  const second = recordingItem();
  const items = new Map([
    [0, first],
    [1, second]
  ]);

  // The reviewer pressed `j` once: that one is revealed.
  assert.equal(revealReviewItem(items, { index: 1, cause: "keypress" }), true);
  const afterKeypress = second.calls.length;

  // Then tabbed to a filter checkbox and pressed Space. The list empties
  // (index -1) and refills (index clamped to 0). Neither may reveal.
  assert.equal(revealReviewItem(new Map(), { index: -1, cause: "list-changed" }), false);
  assert.equal(revealReviewItem(items, { index: 0, cause: "list-changed" }), false);

  assert.deepEqual(first.calls, [], "row 0 must not take focus from the filter checkbox");
  assert.equal(second.calls.length, afterKeypress, "a list change must not re-reveal the old row either");
});

test("a list that shrinks under the cursor clamps without moving focus", () => {
  const last = recordingItem();

  assert.equal(revealReviewItem(new Map([[2, last]]), { index: 2, cause: "list-changed" }), false);
  assert.deepEqual(last.calls, []);
});

test("an item that took focus by click or Tab is followed, not re-focused", () => {
  // onFocus reports the index back to the hook. Focus is already on the
  // item, and calling focus() again from a row would pull it off any
  // control inside that row the reviewer actually clicked.
  const item = recordingItem();

  assert.equal(revealReviewItem(new Map([[3, item]]), { index: 3, cause: "focus-followed" }), false);
  assert.deepEqual(item.calls, []);
});

test("a keypress after a refetch is still revealed", () => {
  // The repair must not overcorrect into never revealing after a list
  // change: the next `j` is a keypress like any other.
  const item = recordingItem();
  const items = new Map([[0, item]]);

  revealReviewItem(items, { index: 0, cause: "list-changed" });
  assert.equal(revealReviewItem(items, { index: 0, cause: "keypress" }), true);
  assert.deepEqual(item.calls, ['focus {"preventScroll":true}', 'scrollIntoView {"block":"nearest"}']);
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

// ---- REV-005: advertised shortcuts match wired callbacks in both directions ----

test("the queue page advertised shortcuts omit source reveal", () => {
  const queueCallbacks = { onOpen: () => {} };
  const shortcuts = filterSupportedShortcuts(REVIEW_SHORTCUTS, resolveReviewKeyAction, queueCallbacks);
  assert.ok(shortcuts.some((s) => s.keys.includes("Enter")), "Enter must be advertised when onOpen is wired");
  assert.ok(!shortcuts.some((s) => s.keys.includes("s")), "s must not be advertised when onRevealSource is not wired");
});

test("the evidence page advertised shortcuts omit open", () => {
  const evidenceCallbacks = { onRevealSource: () => {} };
  const shortcuts = filterSupportedShortcuts(REVIEW_SHORTCUTS, resolveReviewKeyAction, evidenceCallbacks);
  assert.ok(shortcuts.some((s) => s.keys.includes("s")), "s must be advertised when onRevealSource is wired");
  assert.ok(!shortcuts.some((s) => s.keys.includes("Enter")), "Enter must not be advertised when onOpen is not wired");
});

test("unwired actions are not handled and do not swallow keys", () => {
  // on a surface with no onRevealSource, reveal-source must not be handled
  assert.equal(isActionHandled("reveal-source", {}), false);
  assert.equal(isActionHandled("reveal-source", { onOpen: () => {} }), false);
  assert.equal(isActionHandled("reveal-source", { onRevealSource: () => {} }), true);

  // on a surface with no onOpen, open must not be handled
  assert.equal(isActionHandled("open", {}), false);
  assert.equal(isActionHandled("open", { onRevealSource: () => {} }), false);
  assert.equal(isActionHandled("open", { onOpen: () => {} }), true);

  // common actions are always handled
  assert.equal(isActionHandled("next", {}), true);
  assert.equal(isActionHandled("previous", {}), true);
  assert.equal(isActionHandled("first", {}), true);
  assert.equal(isActionHandled("last", {}), true);
  assert.equal(isActionHandled("help", {}), true);
  assert.equal(isActionHandled("none", {}), false);
});

test("two-direction check: every advertised shortcut is handled and every handled shortcut is advertised", () => {
  const cases = [
    { name: "queue surface", callbacks: { onOpen: () => {} } },
    { name: "evidence surface", callbacks: { onRevealSource: () => {} } },
    { name: "neither wired", callbacks: {} },
    { name: "both wired", callbacks: { onOpen: () => {}, onRevealSource: () => {} } }
  ];

  for (const { name, callbacks } of cases) {
    const shortcuts = filterSupportedShortcuts(REVIEW_SHORTCUTS, resolveReviewKeyAction, callbacks);
    const displayed: Readonly<Record<string, string>> = { "↓": "ArrowDown", "↑": "ArrowUp" };
    // Direction 1: every advertised shortcut must be handled
    for (const shortcut of shortcuts) {
      for (const label of shortcut.keys) {
        const key = displayed[label] ?? label;
        const action = resolveReviewKeyAction({ key });
        assert.equal(
          isActionHandled(action, callbacks),
          true,
          `${name}: key ${key} (${shortcut.description}) is advertised but not handled`
        );
      }
    }

    // Direction 2: every key handled must appear in the advertised shortcuts
    const allActions: ReviewKeyAction[] = ["next", "previous", "first", "last", "open", "reveal-source", "help"];
    for (const action of allActions) {
      const handled = isActionHandled(action, callbacks);
      const advertised = shortcuts.some((s) => s.keys.some((k) => resolveReviewKeyAction({ key: k }) === action));
      assert.equal(
        advertised,
        handled,
        `${name}: action ${action} handled=${handled} but advertised=${advertised}`
      );
    }
  }
});

// ---- REV-006: screen reader source context announcement ----

test("source context announcement produces unified text for multiple citations and handles zero citations", () => {
  assert.equal(buildSourceContextAnnouncement(undefined, undefined), "");
  assert.equal(buildSourceContextAnnouncement("python_experience", []), "Nothing to verify for python_experience.");

  const singleCitation = [
    { citation: { document: "resume.pdf", pageOrSection: "page 2", offset: 120 } }
  ];
  assert.equal(
    buildSourceContextAnnouncement("python_experience", singleCitation),
    "Source context for python_experience: resume.pdf, page 2, starting at character 120."
  );

  const multipleCitations = [
    { citation: { document: "cv.pdf", pageOrSection: "section 1", offset: 50 } },
    { citation: { document: "cv.pdf", pageOrSection: "section 3", offset: 200 } }
  ];
  const multiText = buildSourceContextAnnouncement("lead_experience", multipleCitations);
  assert.ok(multiText.includes("section 1"));
  assert.ok(multiText.includes("section 3"));
  assert.equal(multiText.split("Source context for lead_experience:").length - 1, 2);
});
