"use client";

import { useEffect, useState } from "react";

import { nextReviewIndex, resolveReviewKeyAction } from "@signal-audit/domain";
import type { ReviewKeyAction } from "@signal-audit/domain";

/**
 * AF-53: the thin glue over the decision layer in packages/domain.
 *
 * Everything decidable without a browser lives there and is tested
 * exhaustively; this file does the two things that genuinely need a DOM
 * and nothing else -- work out whether focus is in a text field, and
 * attach the listener. Keeping the split at exactly that line is what
 * lets the rules be tested at all in a repository with no jsdom.
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
}

export function useReviewKeyboard(options: ReviewKeyboardOptions): ReviewKeyboardState {
  const { itemCount, onOpen, onRevealSource } = options;
  const [focusedIndex, setFocusedIndex] = useState(itemCount > 0 ? 0 : -1);
  const [helpVisible, setHelpVisible] = useState(false);

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
      setFocusedIndex((current) => {
        const next = nextReviewIndex(action, current, itemCount);
        if (action === "open" && next >= 0) {
          onOpen?.(next);
        }
        if (action === "reveal-source" && next >= 0) {
          onRevealSource?.(next);
        }
        return next;
      });
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [itemCount, onOpen, onRevealSource]);

  useEffect(() => {
    // A list that shrinks under the cursor must not leave focus past the
    // end -- AF-47's filters do exactly that.
    setFocusedIndex((current) => nextReviewIndex("none", current, itemCount));
  }, [itemCount]);

  return { focusedIndex, helpVisible, setFocusedIndex };
}
