/**
 * The lab's one container.
 *
 * Three panes sit side by side and each one scrolls on its own, which only
 * works if they agree about where their chrome ends and their content begins.
 * So the header — title or tabs, a line of meta, an action — is the pane's
 * job, and what a caller passes as children is only ever the scrolling part.
 */
export interface LabPaneTab {
  id: string;
  label: string;
  /** A count worth seeing before the tab is opened. */
  badge?: number | null;
  /** A quiet mark for "there is something here", where a count would mislead. */
  dot?: boolean;
}

export interface LabPaneProps {
  title?: string;
  /** Secondary, right-aligned: a count, a range, a file name. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: {
    items: LabPaneTab[];
    active: string;
    onSelect: (id: string) => void;
    label: string;
  };
  /** Extra class on the pane itself, for the grid to place it. */
  modifier?: string;
  /** Turns off body padding, for a pane whose child draws to the edge. */
  flush?: boolean;
  children: React.ReactNode;
}

export function LabPane({
  title,
  meta,
  actions,
  tabs,
  modifier,
  flush = false,
  children,
}: LabPaneProps): React.JSX.Element {
  return (
    <section className={`lab-pane${modifier ? ` ${modifier}` : ''}`}>
      <header className="lab-pane__head">
        {tabs ? (
          <div className="lab-pane__tabs" role="tablist" aria-label={tabs.label}>
            {tabs.items.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === tabs.active}
                className={`lab-pane__tab${tab.id === tabs.active ? ' lab-pane__tab--active' : ''}`}
                onClick={() => {
                  tabs.onSelect(tab.id);
                }}
              >
                {tab.label}
                {typeof tab.badge === 'number' && (
                  <span className="lab-pane__badge">{tab.badge}</span>
                )}
                {tab.dot === true && <span className="lab-pane__dot" aria-hidden="true" />}
              </button>
            ))}
          </div>
        ) : (
          <h2 className="lab-pane__title">{title}</h2>
        )}

        {meta !== undefined && meta !== null && <span className="lab-pane__meta">{meta}</span>}
        {actions && <div className="lab-pane__actions">{actions}</div>}
      </header>

      <div className={`lab-pane__body${flush ? ' lab-pane__body--flush' : ''}`}>{children}</div>
    </section>
  );
}
