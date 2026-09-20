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

export interface RevealRequest {
  readonly index: number;
  /**
   * How many navigation keys the reviewer has pressed on this surface.
   * Zero means they have pressed none, which is the case on every first
   * render, including the one after the queue finishes loading.
   */
  readonly movementCount: number;
}

/**
 * Returns whether an item was actually revealed, which is what makes this
 * observable from a test.
 *
 * Two refusals, both load-bearing:
 *
 * Nothing is revealed before the reviewer has pressed a navigation key.
 * Selection starts at index 0, so revealing unconditionally would yank
 * DOM focus to the first row as soon as the fetch resolves, throwing away
 * wherever the reviewer had put it and interrupting a screen reader
 * mid-announcement. Focus moves in response to a keypress or not at all.
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
  if (request.movementCount <= 0) {
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
