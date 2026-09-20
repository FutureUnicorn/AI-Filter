"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { nextReviewIndex, resolveReviewKeyAction } from "@signal-audit/domain";
import type { ReviewKeyAction } from "@signal-audit/domain";

import { revealReviewItem } from "./review-focus";
import type { RevealableItem } from "./review-focus";

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
  // Counts navigation keypresses rather than index changes, because the
  // two differ exactly where it matters: on the first render nothing has
  // been pressed and focus must stay where the reviewer put it, and at
  // the end of the list the index stops changing while `j` keeps being a
  // request to show the last row.
  const [movementCount, setMovementCount] = useState(0);

  // Held in a ref as well as in state because key repeat can deliver the
  // next keydown before React has re-rendered; reading the index from
  // state would then move from a position the reviewer has already left.
  const focusedIndexRef = useRef(focusedIndex);
  const itemsRef = useRef(new Map<number, RevealableItem>());
  const callbacksRef = useRef({ onOpen, onRevealSource });

  useEffect(() => {
    callbacksRef.current = { onOpen, onRevealSource };
  }, [onOpen, onRevealSource]);

  const select = useCallback((index: number): void => {
    focusedIndexRef.current = index;
    setFocusedIndex(index);
  }, []);

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
      // preventDefault only for keys actually claimed. Calling it
      // unconditionally would break scrolling and form submission for
      // every key this feature does not use.
      event.preventDefault();
      if (action === "help") {
        setHelpVisible((visible) => !visible);
        return;
      }
      const next = nextReviewIndex(action, focusedIndexRef.current, itemCount);
      select(next);
      setMovementCount((count) => count + 1);
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
    select(nextReviewIndex("none", focusedIndexRef.current, itemCount));
  }, [itemCount, select]);

  useEffect(() => {
    revealReviewItem(itemsRef.current, { index: focusedIndex, movementCount });
  }, [focusedIndex, movementCount]);

  return { focusedIndex, helpVisible, setFocusedIndex: select, registerItem };
}
