import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Page } from './types.js';
import { Icon } from './ui.js';

export function WorkspaceSwitch({
  pages,
  navigate,
}: {
  pages: Page[];
  navigate: (page: Page) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  function open() {
    const panel = dialog.current;
    if (panel && !panel.open) {
      panel.showModal();
      input.current?.focus();
    }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.repeat) {
        event.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const matches = pages.filter((page) => page.toLowerCase().includes(query.trim().toLowerCase()));
  function select(page: Page) {
    dialog.current?.close();
    navigate(page);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (matches[0]) select(matches[0]);
  }
  return (
    <>
      <button
        type="button"
        className="workspace-switch"
        aria-label="Find a page"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={open}
      >
        <Icon name="search" />
        <span>Find a page</span>
        <kbd>Ctrl K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby="switch-title"
        onClose={() => setQuery('')}
      >
        <div className="switch-top">
          <h2 id="switch-title">Find a page</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close page finder"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <form onSubmit={submit}>
          <input
            ref={input}
            type="search"
            aria-label="Search workspace pages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages in your role…"
          />
          <div className="switch-results">
            {matches.length === 0 && <p role="status">No matching pages.</p>}
            {matches.map((page) => (
              <button type="button" key={page} onClick={() => select(page)}>
                <Icon name={page} />
                {page}
                <Icon name="arrow" />
              </button>
            ))}
          </div>
        </form>
      </dialog>
    </>
  );
}
