/**
 * AF-53: keyboard-first review navigation.
 *
 * REV-004: this lived in packages/domain until it was pointed out that it
 * does not belong there. These are DOM key names, help-panel copy and
 * list cursor maths: presentation, not hiring-domain contracts. Every
 * package importing @signal-audit/domain was re-exporting keyboard
 * bindings, and a change to a shortcut label meant a domain-package
 * change and a packages/*\/dist rebuild for the typecheck and
 * integration gates.
 *
 * The original reason for putting it in domain was that this repository
 * has no DOM test infrastructure, so keyboard handling written into a
 * component ships untested. That reason no longer holds on its own:
 * tests/unit/review-keyboard-navigation.test.ts already imports
 * apps/web/src/lib/review-focus.ts directly, so a pure module here is
 * just as testable under node --test. What matters is that the RULES
 * stay pure and exhaustively tested, not which package they sit in.
 *
 * Kept free of runtime @signal-audit/* imports, like review-focus.ts, so
 * the unit suite runs without a prior build. See the guard in
 * tests/architecture/keyboard-navigation-wiring.test.ts.
 */

export type ReviewKeyAction =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "open"
  | "reveal-source"
  | "help"
  | "none";

export interface ReviewKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  /**
   * True when focus is inside a text field or contenteditable region.
   * The caller determines this from the DOM; this module will not guess.
   */
  readonly editingText?: boolean;
}

/**
 * Two refusals come before any binding is considered, and they matter
 * more than the bindings do.
 *
 * A shortcut that fires while a recruiter is typing a correction
 * rationale eats their input -- and AF-50 requires that rationale, so
 * the damage lands on the one field the system insists on. `editingText`
 * suppresses everything.
 *
 * A shortcut that fires with Ctrl, Meta or Alt held steals a browser or
 * operating-system binding: Cmd+K, Ctrl+F, Alt+Left. An application
 * that takes those is harder to use with a keyboard, not easier, which
 * inverts the ticket. Shift is NOT in that list on purpose -- `?` and
 * `G` require it on most layouts, so refusing Shift would refuse two of
 * the bindings below.
 */
export function resolveReviewKeyAction(event: ReviewKeyEvent): ReviewKeyAction {
  if (event.editingText === true) {
    return "none";
  }
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
    return "none";
  }
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    case "g":
    case "Home":
      return "first";
    case "G":
    case "End":
      return "last";
    case "Enter":
      return "open";
    case "s":
      return "reveal-source";
    case "?":
      return "help";
    default:
      return "none";
  }
}

/**
 * Clamped, never wrapped.
 *
 * A review queue that loops from the last candidate back to the first
 * re-presents people who have already been looked at as though they are
 * new, and gives no signal that the list ended. In a tool whose whole
 * purpose is that a human actually saw each candidate, silently
 * restarting is the wrong failure. Reaching the end and staying there
 * is legible; wrapping is not.
 */
export function nextReviewIndex(action: ReviewKeyAction, currentIndex: number, itemCount: number): number {
  if (itemCount <= 0) {
    return -1;
  }
  const clamp = (index: number): number => Math.min(Math.max(index, 0), itemCount - 1);
  switch (action) {
    case "next":
      return clamp(currentIndex + 1);
    case "previous":
      return clamp(currentIndex - 1);
    case "first":
      return 0;
    case "last":
      return itemCount - 1;
    case "open":
    case "reveal-source":
    case "help":
    case "none":
      return clamp(currentIndex);
    default:
      return clamp(currentIndex);
  }
}

export interface ReviewShortcut {
  readonly keys: readonly string[];
  readonly description: string;
}

/**
 * Published so the UI renders the same list the resolver implements,
 * rather than a hand-maintained copy that drifts. A keyboard interface
 * nobody can discover is a mouse-only interface with extra steps, so
 * this is part of the feature rather than documentation of it.
 */
export const REVIEW_SHORTCUTS: readonly ReviewShortcut[] = [
  { keys: ["j", "↓"], description: "Next" },
  { keys: ["k", "↑"], description: "Previous" },
  { keys: ["g", "Home"], description: "First" },
  { keys: ["G", "End"], description: "Last" },
  { keys: ["Enter"], description: "Open the focused item" },
  { keys: ["s"], description: "Reveal the source citation for the focused card" },
  { keys: ["?"], description: "Show these shortcuts" }
];

/**
 * AF-53 / REV-002: `s` reveals the source context for the focused CARD,
 * and the published shortcut list is where that is decided, not here.
 *
 * `REVIEW_SHORTCUTS` describes `s` as "Reveal the source citation for the
 * focused card", and the only movement bindings that exist are j/k/g/G
 * over the card list. There is no binding that moves between the
 * citations inside a card, so a citation-scoped reveal would name a
 * target the reviewer has no way to select: pressing `s` would act on
 * whichever citation happened to sit at the card's index. Making it
 * citation-scoped is therefore not a naming change, it is a second
 * navigation axis plus a published binding for it, and the tests that
 * check the shortcut list against the resolver in both directions would
 * require that binding to be added before it could ship.
 *
 * The reveal is keyed on the criterion id rather than on the position for
 * a second reason: an index survives neither a refetch that reorders the
 * cards nor a criterion being removed, and it silently points at a
 * different card afterwards, whereas an id either matches or does not.
 *
 * Thin on purpose. Its job is to be the one place a position becomes an
 * identity, so there is exactly one line to get wrong and one place to
 * test it. An explicit `focusedIndex < 0` guard was dropped: an empty
 * list reports -1 and `criterionIds[-1]` is already undefined, so the
 * guard could never fail and no negative control could prove it does
 * anything.
 */
export function revealedCriterionId(
  criterionIds: readonly string[],
  focusedIndex: number
): string | undefined {
  return criterionIds[focusedIndex];
}
