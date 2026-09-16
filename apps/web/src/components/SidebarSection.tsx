import { useLocalStorage } from '../hooks/useLocalStorage.js';

/**
 * One collapsible band in a sidebar.
 *
 * Built on `<details>`/`<summary>` rather than a div with a click handler: the
 * open/closed state, the keyboard behaviour and the screen-reader announcement
 * all come free and correct, and the element is already the codebase's idiom
 * for a disclosure.
 *
 * Whether a section is open is a working preference, not application state, so
 * it is remembered per section rather than reset on every navigation. Someone
 * who keeps statistics closed is telling us something; reopening it each time
 * they come back would be ignoring it.
 */

export interface SidebarSectionProps {
  title: string;
  /** A count or short status shown beside the title, right-aligned. */
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  /** Stable key for remembering the open state. Omit to not remember it. */
  storageKey?: string;
  children: React.ReactNode;
}

export function SidebarSection({
  title,
  meta,
  defaultOpen = false,
  storageKey,
  children,
}: SidebarSectionProps): React.JSX.Element {
  const [stored, setStored] = useLocalStorage(
    storageKey ? `ckg.sidebar.${storageKey}` : '',
    null,
  );

  const open = storageKey && stored !== null ? stored === 'open' : defaultOpen;

  return (
    <details
      className="sidebar-section"
      open={open}
      onToggle={(event) => {
        if (!storageKey) return;
        setStored(event.currentTarget.open ? 'open' : 'closed');
      }}
    >
      <summary className="sidebar-section__summary">
        <span className="sidebar-section__chevron" aria-hidden="true" />
        <span className="sidebar-section__title">{title}</span>
        {meta !== undefined && <span className="sidebar-section__meta">{meta}</span>}
      </summary>
      <div className="sidebar-section__body">{children}</div>
    </details>
  );
}
