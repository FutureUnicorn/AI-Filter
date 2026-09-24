import { resolveReviewKeyAction, REVIEW_SHORTCUTS } from "@signal-audit/domain";
import type { ReviewKeyAction, ReviewShortcut } from "@signal-audit/domain";

/**
 * AF-53 / REV-001: moving an index is not moving a reviewer.
 *
 * The first cut of this feature changed React state and drew an outline,
 * which is invisible the moment the selected row is below the fold. In a
 * queue of hundreds, `j` then walks the selection off-screen and `Enter`
 * opens a candidate the reviewer never saw. That is worse than mouse-only
 * review, because it looks like it worked.
 *
 * The decision of WHICH item to reveal and WHETHER to reveal at all is
 * separated from React here so it can be tested at all: this repository
 * has no jsdom and no testing-library, and `node --test` cannot mount a
 * component. The item is described structurally rather than as an
 * `HTMLElement` for the same reason, a stub with two methods satisfies it.
 */
export interface RevealableItem {
  focus(options?: { readonly preventScroll?: boolean }): void;
  scrollIntoView(options?: { readonly block?: "nearest" }): void;
}

export interface ReviewKeyboardCallbacks {
  readonly onOpen?: unknown;
  readonly onRevealSource?: unknown;
}

/**
 * REV-005: whether this action has a handler wired on this surface.
 * Actions with no handler must not swallow their key or be advertised.
 */
export function isActionHandled(
  action: ReviewKeyAction,
  callbacks: ReviewKeyboardCallbacks
): boolean {
  if (action === "none") {
    return false;
  }
  if (action === "open" && callbacks.onOpen === undefined) {
    return false;
  }
  if (action === "reveal-source" && callbacks.onRevealSource === undefined) {
    return false;
  }
  return true;
}

/**
 * REV-005: filter the advertised shortcut list to match what is actually wired.
 */
export function filterSupportedShortcuts(
  callbacks: ReviewKeyboardCallbacks
): readonly ReviewShortcut[] {
  const displayed: Readonly<Record<string, string>> = { "↓": "ArrowDown", "↑": "ArrowUp" };
  return REVIEW_SHORTCUTS.filter((shortcut) => {
    const firstKey = shortcut.keys[0];
    if (firstKey === undefined) {
      return false;
    }
    const key = displayed[firstKey] ?? firstKey;
    const action = resolveReviewKeyAction({ key });
    return isActionHandled(action, callbacks);
  });
}

export interface CardCitationSummary {
  readonly document: string;
  readonly pageOrSection: string;
  readonly offset: number;
}

/**
 * REV-006: construct the screen-reader announcement for revealed source context.
 *
 * One announcement per card, never one per citation, so a card with multiple
 * citations does not queue competing announcements.
 */
export function buildSourceContextAnnouncement(
  criterionId: string | undefined,
  citations: readonly { readonly citation: CardCitationSummary }[] | undefined
): string {
  if (criterionId === undefined || citations === undefined) {
    return "";
  }
  if (citations.length === 0) {
    return `Nothing to verify for ${criterionId}.`;
  }
  return citations
    .map(
      (entry) =>
        `Source context for ${criterionId}: ${entry.citation.document}, ${entry.citation.pageOrSection}, starting at character ${entry.citation.offset}.`
    )
    .join(" ");
}

/**
 * REV-003: why the selection moved. The index changes for reasons that
 * are not keypresses -- a filter refetch empties the list and the clamp
 * walks the index to -1 and back to 0, and clicking a row reports its
 * index back through onFocus -- and none of those may move DOM focus.
 * The cause is stated by whoever moved the index, because by the time an
 * effect sees the new index it can no longer tell which of these it was.
 */
export type SelectionCause =
  /** A navigation key the reviewer pressed on this surface. */
  | "keypress"
  /** The list was emptied, refetched or shrank and the index was clamped. */
  | "list-changed"
  /** The item already took focus (a click or Tab) and the index follows it. */
  | "focus-followed";

export interface RevealRequest {
  readonly index: number;
  readonly cause: SelectionCause;
}

/**
 * Returns whether an item was actually revealed, which is what makes this
 * observable from a test.
 *
 * Two refusals, both load-bearing:
 *
 * Nothing is revealed unless the reviewer pressed a navigation key.
 * Focus moves in response to a keypress or not at all. A list change is
 * the case that matters: toggling an AF-47 filter refetches the queue,
 * and revealing on that would throw a keyboard or screen reader user out
 * of the filter fieldset onto row 0 every time the fetch resolved. The
 * first render after loading is a list change too, so it steals nothing.
 *
 * `focus` is called with `preventScroll` and the scrolling is left to
 * `scrollIntoView({ block: "nearest" })`. The browser's own focus scroll
 * targets every scrollable ancestor and is free to centre the element,
 * which yanks the surrounding rows out of view on every `j`; "nearest"
 * moves the minimum required to make the item visible and does nothing at
 * all when it already is.
 */
export function revealReviewItem(
  items: ReadonlyMap<number, RevealableItem>,
  request: RevealRequest
): boolean {
  if (request.cause !== "keypress") {
    return false;
  }
  if (request.index < 0) {
    return false;
  }
  const item = items.get(request.index);
  if (item === undefined) {
    return false;
  }
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
  return true;
}
