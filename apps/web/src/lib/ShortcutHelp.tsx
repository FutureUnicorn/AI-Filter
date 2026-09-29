"use client";

import { REVIEW_SHORTCUTS } from "./review-keys";
import type { ReviewShortcut } from "./review-keys";

/**
 * AF-53 / REV-005: rendered from the supported shortcut list wired on
 * this surface, so the panel cannot advertise a key nothing handles.
 */
export function ShortcutHelp({
  visible,
  shortcuts = REVIEW_SHORTCUTS
}: {
  readonly visible: boolean;
  readonly shortcuts?: readonly ReviewShortcut[];
}): React.JSX.Element {
  return (
    <aside aria-label="Keyboard shortcuts" hidden={!visible}>
      <h2>Keyboard shortcuts</h2>
      <dl>
        {shortcuts.map((shortcut) => (
          <div key={shortcut.description}>
            <dt>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
            <dd>{shortcut.description}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
