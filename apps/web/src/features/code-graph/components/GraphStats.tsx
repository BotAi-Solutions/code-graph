import type { CodeGraphModel } from '../model/graph-types.js';
import type { GraphSummary } from '../../../types/index.js';
import { formatCount } from '../../../utils/format.js';

/**
 * Five numbers about what is on screen.
 *
 * Every figure describes the *current view*, not the repository, and the
 * tooltip on each says so along with the project total where the API knows it.
 * Mixing the two scopes in one row would be the kind of quiet dishonesty that
 * makes a dashboard useless: "18 modules" has to mean one thing.
 *
 * Kept to a thin strip on purpose. It is orientation, not the subject.
 */

export interface GraphStatsProps {
  model: CodeGraphModel;
  /** Project-wide totals, for the "of N" context. */
  summary: GraphSummary | null;
  truncated: boolean;
}

interface Stat {
  value: number;
  label: string;
  title: string;
}

export function GraphStats({ model, summary, truncated }: GraphStatsProps): React.JSX.Element {
  const { metadata } = model;

  const stats: Stat[] = [
    {
      value: metadata.nodeCount,
      label: 'Nodes',
      title: summary
        ? `${formatCount(metadata.nodeCount)} drawn of ${formatCount(summary.nodeCount)} in the project`
        : 'Nodes in the current view',
    },
    {
      value: metadata.edgeCount,
      label: 'Relationships',
      title: summary
        ? `${formatCount(metadata.edgeCount)} drawn of ${formatCount(summary.edgeCount)} in the project`
        : 'Relationships in the current view',
    },
    {
      value: metadata.modules.length,
      label: 'Modules',
      title: 'Clusters in this view: source directories, external packages and infrastructure',
    },
    {
      value: metadata.entryPointCount,
      label: 'Entry points',
      title: 'HTTP routes, plus files named like a process entry point (index, main, app, server…)',
    },
    {
      value: metadata.externalCount,
      label: 'External',
      title: 'Packages imported from outside this repository',
    },
  ];

  return (
    <div className="graph-stats">
      {stats.map((stat) => (
        <div key={stat.label} className="graph-stats__item" title={stat.title}>
          <span className="graph-stats__value">{formatCount(stat.value)}</span>
          <span className="graph-stats__label">{stat.label}</span>
        </div>
      ))}

      {truncated && (
        <span
          className="graph-stats__flag"
          title="The node limit cut this view short. Narrow the filters or focus a node to see the rest."
        >
          truncated
        </span>
      )}
    </div>
  );
}
