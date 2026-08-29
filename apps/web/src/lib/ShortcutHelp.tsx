"use client";

import { REVIEW_SHORTCUTS } from "@signal-audit/domain";

/**
 * AF-53: rendered from the same list the resolver implements, so the
 * panel cannot advertise a key nothing handles. A keyboard interface
 * nobody can discover is a mouse-only interface with extra steps, which
 * is why this ships with the bindings rather than after them.
 */
export function ShortcutHelp({ visible }: { readonly visible: boolean }): React.JSX.Element {
  return (
    <aside aria-label="Keyboard shortcuts" hidden={!visible}>
      <h2>Keyboard shortcuts</h2>
      <dl>
        {REVIEW_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.description}>
            <dt>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
            <dd>{shortcut.description}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
