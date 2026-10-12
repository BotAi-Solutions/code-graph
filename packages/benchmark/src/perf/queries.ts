import { paramsKey, type QueryRecord } from './results.js';

/**
 * The controlled query workload: what is asked of the graph API once a
 * repository is indexed, and how each answer is timed.
 *
 * Targets are chosen by the harness from the stored graph with a fixed rule:
 * the most connected classes, functions and methods, ties broken by type,
 * name and file — never by id, because ids are hashes of a project that is
 * created afresh on every invocation. Each question carries a `key` built from
 * the same stable identity, so two invocations over the same repository
 * revision ask, and can be compared on, the same questions.
 */

export interface QueryTarget {
  id: string;
  name: string;
  type: string;
  filePath: string | null;
}

export interface PlannedQuery {
  kind: QueryRecord['kind'];
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** Stable across invocations: no ids in it. */
  key: string;
  /** What was sent, ids included. */
  params: Record<string, string | number>;
}

/** `class:UserService@src/user.service.ts` — the target's identity without its id. */
export function targetRef(target: QueryTarget): string {
  return `${target.type}:${target.name}@${target.filePath ?? ''}`;
}

export const TRAVERSAL_DEPTHS = [1, 2, 3, 4, 5] as const;
export const PATH_MAX_DEPTH = 6;
/** A term no identifier should contain: the cost of a search that finds nothing. */
export const NO_MATCH_TERM = 'zzqxj_no_such_symbol';

export function planQueries(projectId: string, targets: readonly QueryTarget[]): PlannedQuery[] {
  const base = `/api/projects/${projectId}`;
  const plan: PlannedQuery[] = [];

  const terms = [...new Set(targets.map((target) => target.name))];
  if (targets[0] && targets[0].name.length > 3) terms.push(targets[0].name.slice(0, 3));
  terms.push(NO_MATCH_TERM);
  for (const term of terms) {
    plan.push({
      kind: 'search',
      method: 'GET',
      path: `${base}/graph/search?q=${encodeURIComponent(term)}&limit=20`,
      key: paramsKey({ q: term, limit: 20 }),
      params: { q: term, limit: 20 },
    });
  }

  for (const target of targets) {
    plan.push({
      kind: 'node_detail',
      method: 'GET',
      path: `${base}/graph/nodes/${encodeURIComponent(target.id)}`,
      key: paramsKey({ node: targetRef(target) }),
      params: { node: target.name, nodeId: target.id },
    });
  }

  for (const target of targets) {
    for (const depth of TRAVERSAL_DEPTHS) {
      plan.push({
        kind: 'traverse',
        method: 'GET',
        path: `${base}/graph?rootNodeId=${encodeURIComponent(target.id)}&depth=${String(depth)}&limit=500`,
        key: paramsKey({ root: targetRef(target), depth, limit: 500 }),
        params: { root: target.name, rootNodeId: target.id, depth, limit: 500 },
      });
    }
  }

  for (let index = 0; index + 1 < targets.length; index += 1) {
    const from = targets[index] as QueryTarget;
    const to = targets[index + 1] as QueryTarget;
    plan.push({
      kind: 'path',
      method: 'POST',
      path: `${base}/graph/path`,
      body: { from: from.id, to: to.id, maxDepth: PATH_MAX_DEPTH },
      key: paramsKey({ from: targetRef(from), to: targetRef(to), maxDepth: PATH_MAX_DEPTH }),
      params: { from: from.name, to: to.name, maxDepth: PATH_MAX_DEPTH },
    });
  }

  return plan;
}

/** `app;dur=12.34` → 12.34. Null when the header is absent or not in that form. */
export function parseServerTiming(header: string | null): number | null {
  if (!header) return null;
  const match = /(?:^|,)\s*app;dur=(\d+(?:\.\d+)?)/.exec(header);
  return match ? Number(match[1]) : null;
}

/**
 * How many things came back. Arrays count their entries, graphs their nodes, a
 * path its nodes. Null when the response says nothing countable.
 */
export function resultCountOf(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.nodes)) return record.nodes.length;
    if (Array.isArray(record.items)) return record.items.length;
    if (typeof record.node === 'object' && record.node !== null) return 1;
  }
  return null;
}

export interface QueryRunOptions {
  baseUrl: string;
  repositoryId: string;
  projectId: string;
  /** Passes over the whole plan that are recorded as warm-up and never summarised. */
  warmupPasses?: number;
  /** Measured passes over the whole plan. */
  iterations: number;
  /** 1-based round number, recorded on every record. */
  round?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Runs the plan `warmupPasses` times as warm-up, then `iterations` measured
 * times, in plan order, one request at a time. A pass is a point in time, not
 * a per-query repetition: drift within a round shows up as a trend across
 * passes, which the per-record timestamps make visible.
 */
export async function runQueries(
  plan: readonly PlannedQuery[],
  options: QueryRunOptions,
): Promise<QueryRecord[]> {
  const fetcher = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const records: QueryRecord[] = [];

  const warmup = options.warmupPasses ?? 0;
  for (let iteration = 0; iteration < warmup + options.iterations; iteration += 1) {
    for (const query of plan) {
      const at = new Date().toISOString();
      const started = now();
      const record: QueryRecord = {
        repositoryId: options.repositoryId,
        projectId: options.projectId,
        kind: query.kind,
        key: query.key,
        params: query.params,
        round: options.round ?? 1,
        warmup: iteration < warmup,
        iteration,
        at,
        status: null,
        ok: false,
        clientMs: null,
        serverMs: null,
        resultCount: null,
        truncated: null,
        responseBytes: null,
        error: null,
      };
      try {
        const response = await fetcher(`${options.baseUrl}${query.path}`, {
          method: query.method,
          ...(query.body
            ? { body: JSON.stringify(query.body), headers: { 'content-type': 'application/json' } }
            : {}),
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
        const text = await response.text();
        record.clientMs = round(now() - started);
        record.status = response.status;
        record.ok = response.ok;
        record.serverMs = parseServerTiming(response.headers.get('server-timing'));
        record.responseBytes = Buffer.byteLength(text);
        let envelope: { data?: unknown; meta?: Record<string, unknown>; error?: { message?: string } };
        try {
          envelope = JSON.parse(text) as typeof envelope;
        } catch {
          // A 2xx whose body is not the API's envelope is not a measured answer.
          record.ok = false;
          record.error = `unparseable response body (HTTP ${String(response.status)})`;
          records.push(record);
          continue;
        }
        record.resultCount = resultCountOf(envelope.data);
        // The graph route says it in meta; a path answer says it in its data.
        const dataTruncated = (envelope.data as { truncated?: unknown } | null | undefined)?.truncated;
        record.truncated =
          typeof envelope.meta?.truncated === 'boolean'
            ? envelope.meta.truncated
            : typeof dataTruncated === 'boolean'
              ? dataTruncated
              : null;
        if (!response.ok) record.error = envelope.error?.message ?? `HTTP ${String(response.status)}`;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      }
      records.push(record);
    }
  }
  return records;
}

function round(milliseconds: number): number {
  return Math.round(milliseconds * 100) / 100;
}
