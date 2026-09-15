import { formatCount } from '../utils/format.js';

export interface StatTileProps {
  label: string;
  value: number | string;
  hint?: string;
  /** Renders larger, for the one number a screen leads with. */
  hero?: boolean;
}

/**
 * A headline number. Deliberately not a chart: a single current value reads
 * faster as text than as a one-bar bar chart.
 */
export function StatTile({ label, value, hint, hero = false }: StatTileProps): React.JSX.Element {
  return (
    <div className={`stat${hero ? ' stat--hero' : ''}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{typeof value === 'number' ? formatCount(value) : value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}
