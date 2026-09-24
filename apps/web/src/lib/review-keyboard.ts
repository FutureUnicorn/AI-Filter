"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nextReviewIndex, resolveReviewKeyAction } from "@signal-audit/domain";
import type { ReviewKeyAction, ReviewShortcut } from "@signal-audit/domain";

import {
  filterSupportedShortcuts,
  isActionHandled,
  revealReviewItem
} from "./review-focus";
import type {
  RevealableItem,
  ReviewKeyboardCallbacks,
  SelectionCause
} from "./review-focus";

export { filterSupportedShortcuts, isActionHandled };
export type { ReviewKeyboardCallbacks };

/**
 * AF-53: the thin glue over the decision layer in packages/domain.
 *
 * Everything decidable without a browser lives there and is tested
 * exhaustively; this file does the things that genuinely need a DOM and
 * nothing else -- work out whether focus is in a text field, attach the
 * listener, and hand the selected element to `revealReviewItem`. Keeping
 * the split at exactly that line is what lets the rules be tested at all
 * in a repository with no jsdom.
 */
function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  // A checkbox is not a text field: AF-47's state filters are checkboxes
  // and a recruiter tabbing through them should still be able to press
  // `j`. Only inputs that swallow characters count.
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return tag === "TEXTAREA" || tag === "SELECT";
}

export interface ReviewKeyboardOptions {
  readonly itemCount: number;
  readonly onOpen?: (index: number) => void;
  readonly onRevealSource?: (index: number) => void;
}

export interface ReviewKeyboardState {
  readonly focusedIndex: number;
  readonly helpVisible: boolean;
  /**
   * REV-005: the shortcuts supported and wired on this surface.
   */
  readonly shortcuts: readonly ReviewShortcut[];
  /**
   * For an item that has already taken focus (click or Tab). Moves the
   * selection to it and never moves DOM focus, because focus is already
   * there.
   */
  readonly setFocusedIndex: (index: number) => void;
  /**
   * REV-001: the selection has to reach the DOM, not just React state.
   * Every navigable row or card passes its element through this so the
   * hook can focus and scroll to the one the reviewer moved to.
   */
  readonly registerItem: (index: number) => (element: RevealableItem | null) => void;
}

export function useReviewKeyboard(options: ReviewKeyboardOptions): ReviewKeyboardState {
  const { itemCount, onOpen, onRevealSource } = options;
  const [focusedIndex, setFocusedIndex] = useState(itemCount > 0 ? 0 : -1);
  const [helpVisible, setHelpVisible] = useState(false);

  // Held in a ref as well as in state because key repeat can deliver the
  // next keydown before React has re-rendered; reading the index from
  // state would then move from a position the reviewer has already left.
  const focusedIndexRef = useRef(focusedIndex);
  const itemsRef = useRef(new Map<number, RevealableItem>());
  const callbacksRef = useRef({ onOpen, onRevealSource });

  const shortcuts = useMemo(
    () => filterSupportedShortcuts({ onOpen, onRevealSource }),
    [onOpen, onRevealSource]
  );

  useEffect(() => {
    callbacksRef.current = { onOpen, onRevealSource };
  }, [onOpen, onRevealSource]);

  // REV-003: every index change states its cause, and the reveal happens
  // here, at the change, rather than in an effect watching focusedIndex.
  // An effect cannot tell a keypress from a filter refetch clamping the
  // index to -1 and back to 0, and the old one inferred intent from a
  // keypress counter that stayed non-zero forever after the first `j`, so
  // every refetch pulled focus out of the filter fieldset onto row 0.
  // Revealing at the keypress also covers the end of the list, where the
  // index does not change but `j` is still a request to see that row.
  const select = useCallback((index: number, cause: SelectionCause): void => {
    focusedIndexRef.current = index;
    setFocusedIndex(index);
    revealReviewItem(itemsRef.current, { index, cause });
  }, []);

  const followFocus = useCallback((index: number): void => select(index, "focus-followed"), [select]);

  const registerItem = useCallback(
    (index: number) =>
      (element: RevealableItem | null): void => {
        if (element === null) {
          itemsRef.current.delete(index);
          return;
        }
        itemsRef.current.set(index, element);
      },
    []
  );

  useEffect(() => {
    function handle(event: KeyboardEvent): void {
      const action: ReviewKeyAction = resolveReviewKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        editingText: isEditingText(event.target)
      });
      if (action === "none") {
        return;
      }
      // REV-005: an action with no handler on this surface must return
      // without calling preventDefault, so the key is not swallowed.
      if (!isActionHandled(action, callbacksRef.current)) {
        return;
      }
      // preventDefault only for keys actually claimed. Calling it
      // unconditionally would break scrolling and form submission for
      // every key this feature does not use.
      event.preventDefault();
      if (action === "help") {
        setHelpVisible((visible) => !visible);
        return;
      }
      const next = nextReviewIndex(action, focusedIndexRef.current, itemCount);
      select(next, "keypress");
      // Called here rather than inside a state updater: an updater must
      // be pure, and React invokes it twice in development, which would
      // route the reviewer to a candidate twice.
      const callbacks = callbacksRef.current;
      if (action === "open" && next >= 0) {
        callbacks.onOpen?.(next);
      }
      if (action === "reveal-source" && next >= 0) {
        callbacks.onRevealSource?.(next);
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [itemCount, select]);

  useEffect(() => {
    // A list that shrinks under the cursor must not leave focus past the
    // end -- AF-47's filters do exactly that.
    select(nextReviewIndex("none", focusedIndexRef.current, itemCount), "list-changed");
  }, [itemCount, select]);

  return { focusedIndex, helpVisible, shortcuts, setFocusedIndex: followFocus, registerItem };
}
