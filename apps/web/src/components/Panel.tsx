export interface PanelProps {
  title?: string;
  tone?: 'default' | 'error';
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function Panel({
  title,
  tone = 'default',
  actions,
  children,
}: PanelProps): React.JSX.Element {
  return (
    <section className={`panel${tone === 'error' ? ' panel--error' : ''}`}>
      {(title ?? actions) && (
        <header className="panel__header">
          {title && <h2 className="panel__title">{title}</h2>}
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
