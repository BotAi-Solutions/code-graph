import type { SourceTreeEntry } from '../../../types/index.js';
import type { FileTreeState } from '../hooks/useFileTree.js';

/**
 * The repository tree, beside the canvas.
 *
 * Built from the `file` and `directory` nodes the indexer produced, which is
 * what makes every row here also a graph node: clicking a file opens its source
 * *and* selects it on the canvas, so the tree is a third way into the same
 * graph rather than a separate view of the disk.
 *
 * A folder loads when it is opened and not before. That is a deliberate limit
 * on how much of a large repository the panel is ever holding, and it is why a
 * row can be open with nothing under it yet.
 */

export interface FileTreeProps {
  tree: FileTreeState;
  /** The selected graph node, so the matching row can say it is selected. */
  selectedNodeId: string | null;
  onOpenFile: (entry: SourceTreeEntry) => void;
  onSelectNode: (nodeId: string) => void;
}

/** Depth beyond which rows stop indenting, so a deep tree stays readable. */
const MAX_INDENT = 8;

export function FileTree({
  tree,
  selectedNodeId,
  onOpenFile,
  onSelectNode,
}: FileTreeProps): React.JSX.Element {
  const root = tree.levels.get('');

  return (
    <div className="filetree">
      {tree.error && <p className="filetree__error">{tree.error}</p>}

      {root === undefined ? (
        <p className="filetree__empty">Loading tree…</p>
      ) : root.length === 0 ? (
        <p className="filetree__empty">
          This graph has no file nodes. Re-analyse the project to index its source tree.
        </p>
      ) : (
        <ul className="filetree__list" role="tree" aria-label="Repository files">
          <Level
            entries={root}
            depth={0}
            tree={tree}
            selectedNodeId={selectedNodeId}
            onOpenFile={onOpenFile}
            onSelectNode={onSelectNode}
          />
        </ul>
      )}
    </div>
  );
}

function Level({
  entries,
  depth,
  tree,
  selectedNodeId,
  onOpenFile,
  onSelectNode,
}: {
  entries: readonly SourceTreeEntry[];
  depth: number;
} & Omit<FileTreeProps, 'tree'> & { tree: FileTreeState }): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => (
        <Row
          key={entry.path}
          entry={entry}
          depth={depth}
          tree={tree}
          selectedNodeId={selectedNodeId}
          onOpenFile={onOpenFile}
          onSelectNode={onSelectNode}
        />
      ))}
    </>
  );
}

function Row({
  entry,
  depth,
  tree,
  selectedNodeId,
  onOpenFile,
  onSelectNode,
}: {
  entry: SourceTreeEntry;
  depth: number;
  tree: FileTreeState;
} & Omit<FileTreeProps, 'tree'>): React.JSX.Element {
  const isDirectory = entry.type === 'directory';
  const open = isDirectory && tree.expanded.has(entry.path);
  const children = open ? tree.levels.get(entry.path) : undefined;
  const loading = tree.loadingPaths.has(entry.path);
  const selected = entry.nodeId !== null && entry.nodeId === selectedNodeId;

  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={isDirectory ? open : undefined}
        aria-selected={selected}
        className={`filetree__row${selected ? ' filetree__row--selected' : ''}`}
        style={{ paddingLeft: `${String(8 + Math.min(depth, MAX_INDENT) * 12)}px` }}
        title={entry.path}
        onClick={() => {
          if (isDirectory) {
            tree.toggle(entry.path);
            return;
          }
          onOpenFile(entry);
          if (entry.nodeId) onSelectNode(entry.nodeId);
        }}
      >
        <span className="filetree__mark" aria-hidden="true">
          {isDirectory ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="filetree__name">{entry.name}</span>
        {loading && <span className="filetree__spinner" aria-hidden="true" />}
      </button>

      {open && (
        <ul className="filetree__list" role="group">
          {children === undefined ? (
            !loading && <li className="filetree__empty filetree__empty--nested">empty</li>
          ) : children.length === 0 ? (
            <li className="filetree__empty filetree__empty--nested">empty</li>
          ) : (
            <Level
              entries={children}
              depth={depth + 1}
              tree={tree}
              selectedNodeId={selectedNodeId}
              onOpenFile={onOpenFile}
              onSelectNode={onSelectNode}
            />
          )}
        </ul>
      )}
    </li>
  );
}
