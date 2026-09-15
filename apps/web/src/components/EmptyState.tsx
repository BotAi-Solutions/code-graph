export interface EmptyStateProps {
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden="true" />
      <h2 className="empty__title">{title}</h2>
      <div className="empty__body">{body}</div>
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
