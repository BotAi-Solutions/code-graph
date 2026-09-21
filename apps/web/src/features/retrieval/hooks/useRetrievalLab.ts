import { useCallback, useRef, useState } from 'react';
import { searchCode, type CodeSearchPage } from '../../../api/code-search.api.js';
import { fetchNodeDetail, findPath, searchNodes } from '../../../api/graph.api.js';
import { fetchSource } from '../../../api/source.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type {
  CodeNode,
  CodeSearchMatch,
  GraphPath,
  NodeDetail,
  SourceWindow,
} from '../../../types/index.js';
import {
  sourceRangeAround,
  type RetrievalCall,
  type SourceRange,
} from '../model/retrieval.js';

/**
 * The lab's state, and the one place a retrieval request is made.
 *
 * Every operation is on demand and independent: searching does not load source,
 * selecting a result does not load a node, and opening a node does not trace a
 * path. That is not only a performance choice — the page exists to show what
 * each retrieval step returns, and a page that fetched everything at once would
 * make it impossible to see which call produced what.
 *
 * Each panel keeps its own loading and error state, so a slow node lookup never
 * blanks the results beside it. And every call is recorded with its URL, status
 * and duration, because the question this page is here to answer is as often
 * "what did we actually send" as "what came back".
 */

export type SearchMode = 'code' | 'graph';

export interface Slot<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The API's own code, when it gave one — shown in the technical details. */
  code: string | null;
}

const IDLE: Slot<never> = { data: null, loading: false, error: null, code: null };

/** A code match or a graph node, whichever the active mode produced. */
export type Target =
  | { kind: 'match'; match: CodeSearchMatch }
  | { kind: 'node'; node: CodeNode };

export interface RetrievalLab {
  calls: RetrievalCall[];
  clearCalls: () => void;

  codeResults: Slot<CodeSearchPage>;
  graphResults: Slot<CodeNode[]>;
  source: Slot<SourceWindow>;
  node: Slot<NodeDetail>;
  trace: Slot<GraphPath>;

  target: Target | null;
  select: (target: Target) => void;

  runCodeSearch: (projectId: string, query: string, limit: number) => Promise<void>;
  runGraphSearch: (projectId: string, query: string, limit: number) => Promise<void>;
  loadSource: (projectId: string, file: string, range: SourceRange) => Promise<void>;
  loadNode: (projectId: string, nodeId: string) => Promise<void>;
  runTrace: (projectId: string, from: string, to: string, maxDepth: number) => Promise<void>;
  reset: () => void;
}

/** The API's stable code, when the failure carried one. */
function codeOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

export function useRetrievalLab(): RetrievalLab {
  const [calls, setCalls] = useState<RetrievalCall[]>([]);
  const [codeResults, setCodeResults] = useState<Slot<CodeSearchPage>>(IDLE);
  const [graphResults, setGraphResults] = useState<Slot<CodeNode[]>>(IDLE);
  const [source, setSource] = useState<Slot<SourceWindow>>(IDLE);
  const [node, setNode] = useState<Slot<NodeDetail>>(IDLE);
  const [trace, setTrace] = useState<Slot<GraphPath>>(IDLE);
  const [target, setTarget] = useState<Target | null>(null);

  /**
   * One in-flight request per panel. A second click while the first is running
   * aborts it rather than racing it, so a slow answer can never overwrite a
   * newer one — the same rule `useAsync` follows for the rest of the app.
   */
  const inflight = useRef<Record<string, AbortController | undefined>>({});

  const run = useCallback(
    async <T,>(
      slot: string,
      set: (value: Slot<T>) => void,
      describe: Omit<RetrievalCall, 'status' | 'durationMs' | 'error'>,
      call: (signal: AbortSignal) => Promise<T>,
    ): Promise<void> => {
      inflight.current[slot]?.abort();
      const controller = new AbortController();
      inflight.current[slot] = controller;

      set({ data: null, loading: true, error: null, code: null });
      const started = performance.now();

      try {
        const data = await call(controller.signal);
        if (controller.signal.aborted) return;

        set({ data, loading: false, error: null, code: null });
        setCalls((previous) => [
          { ...describe, status: 200, durationMs: performance.now() - started, error: null },
          ...previous.slice(0, 19),
        ]);
      } catch (error) {
        if (controller.signal.aborted) return;

        const message = errorMessage(error);
        set({ data: null, loading: false, error: message, code: codeOf(error) });
        setCalls((previous) => [
          {
            ...describe,
            status: typeof (error as { status?: number }).status === 'number'
              ? (error as { status: number }).status
              : null,
            durationMs: performance.now() - started,
            error: message,
          },
          ...previous.slice(0, 19),
        ]);
      }
    },
    [],
  );

  const runCodeSearch = useCallback(
    async (projectId: string, query: string, limit: number) => {
      // Selecting a result from a previous search would make no sense against
      // new results, so the investigation panels go with it.
      setTarget(null);
      setSource(IDLE);
      setNode(IDLE);
      setTrace(IDLE);

      await run<CodeSearchPage>(
        'search',
        setCodeResults,
        {
          method: 'GET',
          url: `/api/projects/${projectId}/code/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`,
        },
        (signal) => searchCode(projectId, query, { limit }, signal),
      );
    },
    [run],
  );

  const runGraphSearch = useCallback(
    async (projectId: string, query: string, limit: number) => {
      setTarget(null);
      setSource(IDLE);
      setNode(IDLE);
      setTrace(IDLE);

      await run<CodeNode[]>(
        'search',
        setGraphResults,
        {
          method: 'GET',
          url: `/api/projects/${projectId}/graph/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`,
        },
        async (signal) => (await searchNodes(projectId, query, { limit }, signal)).nodes,
      );
    },
    [run],
  );

  const loadSource = useCallback(
    async (projectId: string, file: string, range: SourceRange) => {
      await run<SourceWindow>(
        'source',
        setSource,
        {
          method: 'GET',
          url: `/api/projects/${projectId}/source?file=${encodeURIComponent(file)}&startLine=${String(range.startLine)}&endLine=${String(range.endLine)}`,
        },
        (signal) => fetchSource(projectId, { file, ...range }, signal),
      );
    },
    [run],
  );

  const loadNode = useCallback(
    async (projectId: string, nodeId: string) => {
      await run<NodeDetail>(
        'node',
        setNode,
        {
          method: 'GET',
          url: `/api/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}`,
        },
        (signal) => fetchNodeDetail(projectId, nodeId, signal),
      );
    },
    [run],
  );

  const runTrace = useCallback(
    async (projectId: string, from: string, to: string, maxDepth: number) => {
      await run<GraphPath>(
        'trace',
        setTrace,
        {
          method: 'POST',
          url: `/api/projects/${projectId}/graph/path`,
          // The API's own field names, which is what the request inspector is
          // for showing.
          body: { from, to, maxDepth },
        },
        (signal) => findPath(projectId, { from, to, maxDepth }, signal),
      );
    },
    [run],
  );

  const select = useCallback((next: Target) => {
    setTarget(next);
    setSource(IDLE);
    setNode(IDLE);
  }, []);

  const reset = useCallback(() => {
    for (const controller of Object.values(inflight.current)) controller?.abort();
    inflight.current = {};
    setCodeResults(IDLE);
    setGraphResults(IDLE);
    setSource(IDLE);
    setNode(IDLE);
    setTrace(IDLE);
    setTarget(null);
  }, []);

  const clearCalls = useCallback(() => {
    setCalls([]);
  }, []);

  return {
    calls,
    clearCalls,
    codeResults,
    graphResults,
    source,
    node,
    trace,
    target,
    select,
    runCodeSearch,
    runGraphSearch,
    loadSource,
    loadNode,
    runTrace,
    reset,
  };
}

export { sourceRangeAround };
