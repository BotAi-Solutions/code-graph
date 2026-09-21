import type {
  AnalysisJob,
  CodeSearchMatch,
  GraphPath,
  NodeDetail,
  ProjectSummary,
  RelatedNode,
  CodeNode,
} from '../../../types/index.js';
import type { CodeSearchMeta } from '../../../api/code-search.api.js';

/**
 * The Retrieval Lab's decisions, as pure functions.
 *
 * Same arrangement the explorer uses: a component that decided whether a search
 * was complete, or what a path result meant, could only be checked by driving a
 * browser. These can be checked exhaustively, and the components that call them
 * are left with nothing to get wrong but layout.
 *
 * Every one of them reads the API's own fields. None invents a number, and
 * where the API says a count is a floor, that distinction survives to the
 * label — the whole point of this page is to show what retrieval actually
 * returns, so a UI that rounded off the caveats would defeat it.
 */

// --- index status ----------------------------------------------------------

export const INDEX_STATES = ['ready', 'indexing', 'failed', 'never_indexed'] as const;
export type IndexState = (typeof INDEX_STATES)[number];

export interface IndexStatus {
  state: IndexState;
  /**
   * Whether a stored graph exists to query *now*.
   *
   * Not the same question as `state`. The pipeline replaces a project's graph
   * in one step at the end of a run, so a failed or in-flight run leaves the
   * previous graph exactly where it was — which is why an earlier completed run
   * still counts.
   */
  usable: boolean;
  /** The most recent run, or null when there has never been one. */
  latest: AnalysisJob | null;
  /** The most recent completed run, when it is not the latest one. */
  lastSuccessful: AnalysisJob | null;
  nodeCount: number | null;
  edgeCount: number | null;
  warningCount: number;
  error: string | null;
}

/**
 * Reads the run list the API returns, newest first.
 *
 * This is a reading, not a second implementation of anything: every field comes
 * from a run record, and the four states are the four situations that call for
 * different behaviour from someone using the page.
 */
export function readIndexStatus(runs: readonly AnalysisJob[]): IndexStatus {
  const latest = runs[0] ?? null;

  if (!latest) {
    return {
      state: 'never_indexed',
      usable: false,
      latest: null,
      lastSuccessful: null,
      nodeCount: null,
      edgeCount: null,
      warningCount: 0,
      error: null,
    };
  }

  const state: IndexState =
    latest.status === 'COMPLETED' ? 'ready' : latest.status === 'FAILED' ? 'failed' : 'indexing';

  const previous = runs.slice(1).find((run) => run.status === 'COMPLETED') ?? null;

  return {
    state,
    usable: state === 'ready' ? true : previous !== null,
    latest,
    lastSuccessful: state === 'ready' ? null : previous,
    nodeCount: latest.stats?.nodeCount ?? null,
    edgeCount: latest.stats?.edgeCount ?? null,
    warningCount: latest.errors.length,
    error: latest.error,
  };
}

export const INDEX_STATE_LABEL: Record<IndexState, string> = {
  ready: 'Ready',
  indexing: 'Indexing',
  failed: 'Failed',
  never_indexed: 'Never indexed',
};

/**
 * Why retrieval may not work, or null when nothing needs saying.
 *
 * `usable` rather than `state` decides, because a failed re-index over a graph
 * that is still there is a caveat, not a blocker.
 */
export function indexCaveat(status: IndexStatus): string | null {
  switch (status.state) {
    case 'ready':
      return null;
    case 'never_indexed':
      return 'This project has never been indexed, so graph retrieval will return nothing. Code search reads the files directly and still works.';
    case 'failed':
      return status.usable
        ? 'The most recent indexing run failed. An earlier graph is still stored, so graph retrieval works but may be out of date.'
        : 'Indexing failed and no graph was ever stored, so graph retrieval will return nothing. Code search reads the files directly and still works.';
    case 'indexing':
      return status.usable
        ? 'Indexing is running. An earlier graph is still stored, so results predate this run.'
        : 'Indexing is running and no graph is stored yet, so graph retrieval will return nothing until it finishes.';
  }
}

/** Graph retrieval needs a stored graph; code search only needs the files. */
export function graphRetrievalEnabled(status: IndexStatus | null): boolean {
  return status?.usable ?? false;
}

// --- project selector ------------------------------------------------------

export interface ProjectOption {
  id: string;
  label: string;
  /** The repository path, when one is attached — what tells two projects apart. */
  detail: string | null;
}

/**
 * Projects as something a person can choose between.
 *
 * The id is what every request uses and the last thing anyone should have to
 * read, so the label leads and the path disambiguates — two projects indexed
 * from the same repository under different names are otherwise identical on
 * screen.
 */
export function projectOptions(projects: readonly ProjectSummary[]): ProjectOption[] {
  return projects.map((project) => ({
    id: project.id,
    label: project.name,
    detail: project.repository?.sourcePath ?? null,
  }));
}

// --- code search -----------------------------------------------------------

/**
 * How many matches were found, said accurately.
 *
 * Three different sentences because they are three different claims. A
 * truncated scan never gets an "of N" phrasing: N is a floor, and the shortfall
 * is unknown.
 */
export function codeSearchSummary(meta: CodeSearchMeta, returned: number): string {
  if (meta.scanTruncated) {
    return `Showing ${String(returned)} match${returned === 1 ? '' : 'es'} — at least ${String(meta.total)} exist`;
  }
  if (meta.truncated) {
    return `Showing ${String(returned)} of ${String(meta.total)} matches`;
  }
  return `${String(meta.total)} match${meta.total === 1 ? '' : 'es'}`;
}

export interface RetrievalWarning {
  title: string;
  body: string;
}

/**
 * What the match count is not a statement about.
 *
 * Both of these make `total` a floor. They are shown with their numbers because
 * someone validating retrieval needs to know what was not looked at, not merely
 * that something was not.
 */
export function codeSearchWarnings(meta: CodeSearchMeta): RetrievalWarning[] {
  const warnings: RetrievalWarning[] = [];

  if (meta.scanTruncated) {
    warnings.push({
      title: 'Repository scan incomplete',
      body: `The walk stopped before the whole tree was examined (${String(meta.filesSearched)} files searched), so the match count is a floor rather than a total.`,
    });
  }

  if (meta.filesSkipped > 0) {
    warnings.push({
      title: `${String(meta.filesSkipped)} file${meta.filesSkipped === 1 ? '' : 's'} skipped`,
      body: `${meta.filesSkipped === 1 ? 'A file was' : 'Files were'} passed over for exceeding the source-search size limit, so a match inside ${meta.filesSkipped === 1 ? 'it' : 'them'} would not appear here.`,
    });
  }

  return warnings;
}

/** A stable key for a match, since occurrences share a file and sometimes a line. */
export function matchKey(match: CodeSearchMatch): string {
  return `${match.filePath}:${String(match.line)}:${String(match.column)}`;
}

export interface MatchGroup {
  filePath: string;
  matches: CodeSearchMatch[];
}

/**
 * Occurrences gathered under the file they are in.
 *
 * The API orders results by file, then line, then column, so this walks the
 * page in order rather than sorting it: the list on screen stays in the order
 * the contract promises, and nine hits in one file read as one file with nine
 * hits instead of nine rows repeating the same path.
 */
export function groupMatchesByFile(matches: readonly CodeSearchMatch[]): MatchGroup[] {
  const groups: MatchGroup[] = [];

  for (const match of matches) {
    const last = groups.at(-1);
    if (last && last.filePath === match.filePath) last.matches.push(match);
    else groups.push({ filePath: match.filePath, matches: [match] });
  }

  return groups;
}

/**
 * A path split at its last separator, so a narrow column can shorten the
 * directories and always keep the file name — which is the part being read.
 */
export function splitPath(filePath: string): { directory: string; name: string } {
  const cut = filePath.lastIndexOf('/');
  return cut === -1
    ? { directory: '', name: filePath }
    : { directory: filePath.slice(0, cut + 1), name: filePath.slice(cut + 1) };
}

export interface MatchSegment {
  text: string;
  /** True for the matched run itself, which the row lights up. */
  hit: boolean;
}

/**
 * The result line, split so the matched run can be lit.
 *
 * `column` indexes the *whole* line, and `lineText` is a window of it when the
 * line was too long to carry — so the offset is trusted only where it lands on
 * the matched text, and a windowed line falls back to finding the run. Where
 * neither holds the line is returned whole rather than lit in the wrong place:
 * a highlight in the wrong column on a page built to check retrieval would be
 * a lie about what was found.
 */
export function matchSegments(match: CodeSearchMatch): MatchSegment[] {
  const { lineText, match: needle } = match;
  if (needle === '') return [{ text: lineText, hit: false }];

  const at =
    lineText.slice(match.column, match.column + needle.length) === needle
      ? match.column
      : lineText.indexOf(needle);

  if (at === -1) return [{ text: lineText, hit: false }];

  const segments: MatchSegment[] = [];
  let from = 0;
  let index = at;

  while (index !== -1) {
    if (index > from) segments.push({ text: lineText.slice(from, index), hit: false });
    segments.push({ text: needle, hit: true });
    from = index + needle.length;
    index = lineText.indexOf(needle, from);
  }

  if (from < lineText.length) segments.push({ text: lineText.slice(from), hit: false });

  return segments;
}

// --- source window ---------------------------------------------------------

/** Lines shown either side of a match. Enough to place it, little enough to read. */
export const SOURCE_CONTEXT_LINES = 6;

export interface SourceRange {
  startLine: number;
  endLine: number;
}

/**
 * A bounded window around a line.
 *
 * Computed here rather than sent as a `context` parameter because the API
 * applies `context` only to a range that came from a node's indexed span — for
 * a file and a line it is ignored. So the window is expressed the way the API
 * will honour it: as an explicit range.
 */
export function sourceRangeAround(line: number, context = SOURCE_CONTEXT_LINES): SourceRange {
  return { startLine: Math.max(1, line - context), endLine: line + context };
}

// --- node inspection -------------------------------------------------------

export interface RelationshipSection {
  key: string;
  label: string;
  nodes: (CodeNode | RelatedNode)[];
}

const SECTION_LABELS: [keyof NodeDetail, string][] = [
  ['callers', 'Called by'],
  ['callees', 'Calls'],
  ['references', 'References'],
  ['dependencies', 'Depends on'],
  ['dependents', 'Depended on by'],
  ['implementations', 'Implements / implemented by'],
  ['apis', 'APIs'],
  ['databases', 'Data stores'],
  ['documentation', 'Documentation'],
  ['contracts', 'Contracts'],
  ['children', 'Contains'],
];

/**
 * The sections worth drawing, which is the ones that have something in them.
 *
 * A node with three callers and nothing else should show one heading, not
 * eleven headings and ten ways of saying "none" — the empty ones are noise on a
 * page whose job is to make what *was* retrieved obvious.
 */
export function relationshipSections(detail: NodeDetail): RelationshipSection[] {
  return SECTION_LABELS.flatMap(([key, label]) => {
    const nodes = detail[key] as (CodeNode | RelatedNode)[] | undefined;
    if (!nodes || nodes.length === 0) return [];
    return [{ key: String(key), label, nodes }];
  });
}

/** True when this neighbour carries the relationship and evidence a related node has. */
export function isRelated(node: CodeNode | RelatedNode): node is RelatedNode {
  return 'relationship' in node;
}

/**
 * Where an edge was observed, from whichever coordinates it carries.
 *
 * An analyzer may record a line without a file — the file is implied by the
 * node it was reading — so checking for a file alone would report "no location"
 * about evidence that has one.
 */
export function evidenceLocation(
  evidence: { file?: string | undefined; line?: number | undefined } | null | undefined,
): string | null {
  if (!evidence) return null;
  if (evidence.file !== undefined) {
    return evidence.line === undefined ? evidence.file : `${evidence.file}:${String(evidence.line)}`;
  }
  return evidence.line === undefined ? null : `line ${String(evidence.line)}`;
}

// --- trace path ------------------------------------------------------------

export type TraceOutcome = 'found' | 'none' | 'inconclusive';

export interface TraceVerdict {
  outcome: TraceOutcome;
  title: string;
  body: string | null;
}

/**
 * What a path result actually says.
 *
 * The third state is the one that matters. `found: false` with
 * `truncated: true` means the search spent its node budget before it could
 * conclude — reporting that as "no path found" would be a claim the server
 * never made, and on a page built to validate retrieval that would be exactly
 * the wrong lesson to teach.
 */
export function traceVerdict(path: GraphPath, maxDepth: number): TraceVerdict {
  if (path.found) {
    return {
      outcome: 'found',
      title: path.depth === 0 ? 'Same node' : 'Path found',
      body: path.undirected
        ? 'No directed route exists, so this one ignores edge direction. The two are related, but the first does not reach the second by following the flow.'
        : null,
    };
  }

  if (path.truncated) {
    return {
      outcome: 'inconclusive',
      title: 'Path search was truncated',
      body: 'The search spent its node budget before it could conclude. This does not mean no route exists — try a smaller max depth, or two nodes that are closer together.',
    };
  }

  return {
    outcome: 'none',
    title: `No path found within ${String(maxDepth)} hop${maxDepth === 1 ? '' : 's'}`,
    body: 'Both nodes exist; no chain of recorded relationships connects them in either direction at that depth.',
  };
}

// --- request inspector -----------------------------------------------------

export interface RetrievalCall {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  status: number | null;
  /** Round-trip time, measured in the browser. */
  durationMs: number;
  error: string | null;
}

/** The request line, wrapped so a long query string stays readable. */
export function formatCall(call: RetrievalCall): string[] {
  const [path, query] = call.url.split('?');
  const lines = [`${call.method} ${path ?? call.url}`];

  if (query) {
    for (const part of query.split('&')) lines.push(`  ${part.startsWith('&') ? part : `&${part}`}`);
    // The first parameter opens the query string rather than continuing it.
    lines[1] = lines[1]?.replace('&', '?') ?? '';
  }

  if (call.body !== undefined) lines.push(`  ${JSON.stringify(call.body)}`);

  return lines;
}

export function callStatusLabel(call: RetrievalCall): string {
  if (call.error !== null) return call.error;
  return `${String(call.status ?? 0)} · ${String(Math.round(call.durationMs))} ms`;
}
