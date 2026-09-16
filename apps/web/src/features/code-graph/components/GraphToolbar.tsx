/**
 * The floating graph toolbar.
 *
 * Sits over the canvas rather than above it, because the canvas is the
 * workspace and a control strip that pushes it down costs a band of the graph
 * on every screen. Three groups, separated by hairlines: navigation, framing,
 * and what the view shows.
 *
 * Toggles are stateful buttons rather than a menu: there are seven of them, a
 * menu would hide which are on, and "why are there no labels" is exactly the
 * question a hidden toggle produces.
 */

export interface GraphViewToggles {
  labels: boolean;
  edgeLabels: boolean;
  animate: boolean;
  minimap: boolean;
}

export interface GraphToolbarProps {
  toggles: GraphViewToggles;
  /** Null disables "centre selection". */
  selectedNodeId: string | null;
  fullscreen: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onCenterSelection: () => void;
  onReset: () => void;
  onToggle: (key: keyof GraphViewToggles) => void;
  onToggleFullscreen: () => void;
}

export function GraphToolbar({
  toggles,
  selectedNodeId,
  fullscreen,
  onZoomIn,
  onZoomOut,
  onFit,
  onCenterSelection,
  onReset,
  onToggle,
  onToggleFullscreen,
}: GraphToolbarProps): React.JSX.Element {
  return (
    <div className="graph-controls" role="toolbar" aria-label="Graph controls">
      <div className="graph-controls__group">
        <Control label="Zoom in" onClick={onZoomIn}>
          <Icon name="plus" />
        </Control>
        <Control label="Zoom out" onClick={onZoomOut}>
          <Icon name="minus" />
        </Control>
        <Control label="Fit graph to view" onClick={onFit}>
          <Icon name="fit" />
        </Control>
      </div>

      <div className="graph-controls__group">
        <Control
          label="Centre the selected node"
          disabled={selectedNodeId === null}
          onClick={onCenterSelection}
        >
          <Icon name="target" />
        </Control>
        <Control label="Reset the view" onClick={onReset}>
          <Icon name="reset" />
        </Control>
      </div>

      <div className="graph-controls__group">
        <Control
          label="Node labels"
          pressed={toggles.labels}
          onClick={() => {
            onToggle('labels');
          }}
        >
          <Icon name="label" />
        </Control>
        <Control
          label="Relationship labels"
          pressed={toggles.edgeLabels}
          onClick={() => {
            onToggle('edgeLabels');
          }}
        >
          <Icon name="edgeLabel" />
        </Control>
        <Control
          label="Flow animation"
          pressed={toggles.animate}
          onClick={() => {
            onToggle('animate');
          }}
        >
          <Icon name="flow" />
        </Control>
        <Control
          label="Minimap"
          pressed={toggles.minimap}
          onClick={() => {
            onToggle('minimap');
          }}
        >
          <Icon name="minimap" />
        </Control>
      </div>

      <div className="graph-controls__group">
        <Control
          label={fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
          pressed={fullscreen}
          onClick={onToggleFullscreen}
        >
          <Icon name={fullscreen ? 'collapse' : 'expand'} />
        </Control>
      </div>
    </div>
  );
}

function Control({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`graph-controls__button${pressed ? ' graph-controls__button--on' : ''}`}
      title={label}
      aria-label={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      disabled={disabled ?? false}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type IconName =
  | 'plus'
  | 'minus'
  | 'fit'
  | 'target'
  | 'reset'
  | 'label'
  | 'edgeLabel'
  | 'flow'
  | 'minimap'
  | 'expand'
  | 'collapse';

const PATHS: Record<IconName, React.ReactNode> = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  fit: <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />,
  target: (
    <>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </>
  ),
  reset: (
    <>
      <path d="M3 8a5 5 0 1 1 1.6 3.7" />
      <path d="M3 5v3h3" />
    </>
  ),
  label: (
    <>
      <circle cx="4.2" cy="8" r="2.2" />
      <path d="M8 6h5.5M8 10h3.5" />
    </>
  ),
  edgeLabel: (
    <>
      <path d="M2 11l12-6" />
      <rect x="5.5" y="6.2" width="5" height="3.6" rx="1" />
    </>
  ),
  flow: (
    <>
      <path d="M2 8h12" />
      <circle cx="6" cy="8" r="1.4" />
      <circle cx="11" cy="8" r="1.4" />
    </>
  ),
  minimap: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <rect x="4.5" y="5.5" width="5" height="4" rx="0.8" />
    </>
  ),
  expand: <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" />,
  collapse: <path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" />,
};

function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
