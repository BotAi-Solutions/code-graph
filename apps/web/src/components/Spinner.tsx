export function Spinner({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span className="spinner__dot" />
      <span className="spinner__dot" />
      <span className="spinner__dot" />
    </span>
  );
}
