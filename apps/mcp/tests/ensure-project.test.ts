import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalysisJob, IndexFreshness, IndexProjectResult, ProjectResolution } from '@ckg/shared';
import { ensureCurrentProjectOnStartup } from '../src/server.js';
import { ProjectRootError, resolveProjectRoot } from '../src/project-root.js';
import {
  PROJECT_ID,
  analysisJob,
  apiFailure,
  createMcpHarness,
  indexFreshness,
  indexProjectResult,
  ok,
  projectSummary,
  textOf,
  toolNamed,
  type ApiStubHandler,
  type McpHarness,
  type StubbedRequest,
} from './helpers/harness.js';

/**
 * `ensure_project` against a stub API: which calls it makes for each state a
 * project can be in, and — as much as what it does — what it refrains from.
 *
 * The directories are real, because validating the root is this tool's own
 * work; the API is a stub, because what the API does with a request is tested
 * in `apps/api` and end to end in `ensure-project.integration.test.ts`.
 */

let harness: McpHarness | undefined;
let scratch: string;
let repo: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ckg-ensure-')));
  repo = await makeRepository('app');
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function makeRepository(relative: string): Promise<string> {
  const directory = path.join(scratch, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{"name":"app"}\n');
  return directory;
}

const QUEUED_JOB_ID = '22222222-2222-4222-8222-222222222222';
const queuedJob = (): AnalysisJob =>
  analysisJob({ id: QUEUED_JOB_ID, status: 'QUEUED', startedAt: null, completedAt: null, stats: null, createdAt: new Date().toISOString() });

/**
 * The API as the project's state would make it answer: what resolve finds,
 * the runs listed before and after any index request, and freshness.
 */
function apiFor(state: {
  registered: boolean;
  exact?: boolean;
  runs: AnalysisJob[];
  runsAfterIndex?: AnalysisJob[];
  freshness?: IndexFreshness;
  indexResult?: Partial<IndexProjectResult>;
}): ApiStubHandler {
  let indexed = false;

  return (request) => {
    if (request.path === '/api/projects/resolve') {
      const matches: ProjectResolution['matches'] = state.registered
        ? [
            {
              project: projectSummary({ id: PROJECT_ID, name: 'app' }),
              repositoryRoot: state.exact === false ? path.dirname(request.query.path ?? '') : (request.query.path ?? ''),
              relativePath: state.exact === false ? path.basename(request.query.path ?? '') : '',
              exact: state.exact !== false,
            },
          ]
        : [];
      return { body: ok({ path: request.query.path, matches }) };
    }

    if (request.path === '/api/projects/index' && request.method === 'POST') {
      indexed = true;
      const root = (request.body as { path: string }).path;
      return {
        status: 202,
        body: ok(indexProjectResult({ repositoryRoot: root, projectName: path.basename(root), job: queuedJob(), ...state.indexResult })),
      };
    }

    if (request.path === `/api/projects/${PROJECT_ID}/analysis`) {
      return { body: ok(indexed ? (state.runsAfterIndex ?? state.runs) : state.runs) };
    }

    if (request.path === `/api/projects/${PROJECT_ID}/freshness`) {
      return { body: ok(state.freshness ?? indexFreshness()) };
    }

    return { status: 404, body: apiFailure('NOT_FOUND', `unexpected ${request.path}`) };
  };
}

function indexRequests(requests: StubbedRequest[]): StubbedRequest[] {
  return requests.filter((request) => request.path === '/api/projects/index');
}

async function ensure(args: Record<string, unknown> = {}) {
  if (!harness) throw new Error('no harness');
  const result = await harness.client.callTool({ name: 'ensure_project', arguments: args });
  return {
    result,
    text: textOf(result),
    data: result.structuredContent as Record<string, unknown> | undefined,
  };
}

const currentProject = () => ({ path: repo, source: 'CLAUDE_PROJECT_DIR' as const });

describe('ensure_project', () => {
  it('describes itself as a readiness check, not something to call before every query', async () => {
    harness = await createMcpHarness();
    const tool = await toolNamed(harness, 'ensure_project');

    expect(tool.description).toMatch(/registered with CodeRAG/);
    expect(tool.description).toMatch(/only when/);
    expect(tool.description).toMatch(/not before every query/);
    expect((tool.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });

  it('A: registers a new project from the current project root and starts indexing', async () => {
    harness = await createMcpHarness(
      apiFor({ registered: false, runs: [], runsAfterIndex: [queuedJob()] }),
      { project: currentProject() },
    );

    const { data, text } = await ensure();

    expect(indexRequests(harness.requests)).toEqual([
      { path: '/api/projects/index', query: {}, method: 'POST', body: { path: repo, force: false } },
    ]);
    expect(data).toMatchObject({
      projectId: PROJECT_ID,
      rootPath: repo,
      rootSource: 'CLAUDE_PROJECT_DIR',
      action: 'registered',
      status: 'indexing',
      registered: true,
      projectCreated: true,
      indexingStarted: true,
      indexed: false,
      indexing: true,
      indexingJobId: QUEUED_JOB_ID,
    });
    expect(text).toContain('Registered');
    expect(text).toContain('get_index_status');
  });

  it('B: reuses an indexed, current project and starts nothing', async () => {
    harness = await createMcpHarness(apiFor({ registered: true, runs: [analysisJob()] }), {
      project: currentProject(),
    });

    const { data } = await ensure();

    expect(indexRequests(harness.requests)).toEqual([]);
    expect(data).toMatchObject({
      projectId: PROJECT_ID,
      action: 'up_to_date',
      status: 'ready',
      projectCreated: false,
      indexingStarted: false,
      indexed: true,
      indexing: false,
      indexingJobId: null,
      stale: false,
      indexedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currentCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      changedFiles: 0,
    });
  });

  it('C: detects a stale project and starts a re-index through index_project’s route', async () => {
    const stale = indexFreshness({
      state: 'stale',
      currentCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      changedFiles: 2,
      changedPaths: ['src/a.ts', 'src/b.ts'],
      reason: '2 files changed',
    });
    harness = await createMcpHarness(
      apiFor({
        registered: true,
        runs: [analysisJob()],
        runsAfterIndex: [queuedJob(), analysisJob()],
        freshness: stale,
        indexResult: { action: 'started', projectCreated: false, freshness: stale, reason: 'Re-index queued because the graph is stale: 2 files changed' },
      }),
      { project: currentProject() },
    );

    const { data, text } = await ensure();

    expect(indexRequests(harness.requests)).toHaveLength(1);
    expect(data).toMatchObject({
      action: 'started',
      status: 'indexing',
      projectCreated: false,
      indexingStarted: true,
      indexed: true,
      indexing: true,
      indexingJobId: QUEUED_JOB_ID,
      stale: true,
      indexedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currentCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      changedFiles: 2,
      changedPaths: ['src/a.ts', 'src/b.ts'],
    });
    expect(text).toContain('stale');
  });

  it('D: reports a run already in progress instead of starting another', async () => {
    const running = analysisJob({ id: QUEUED_JOB_ID, status: 'INDEXING', completedAt: null, stats: null });
    harness = await createMcpHarness(apiFor({ registered: true, runs: [running] }), {
      project: currentProject(),
    });

    const { data } = await ensure();

    expect(indexRequests(harness.requests)).toEqual([]);
    expect(data).toMatchObject({
      action: 'already_indexing',
      status: 'indexing',
      indexing: true,
      indexingStarted: false,
      indexingJobId: QUEUED_JOB_ID,
    });
  });

  it('E: concurrent calls share one check and send at most one index request', async () => {
    harness = await createMcpHarness(
      apiFor({ registered: false, runs: [], runsAfterIndex: [queuedJob()] }),
      { project: currentProject() },
    );

    const results = await Promise.all([ensure(), ensure(), ensure(), ensure({ rootPath: repo })]);

    expect(indexRequests(harness.requests)).toHaveLength(1);
    expect(harness.requests.filter((request) => request.path === '/api/projects/resolve')).toHaveLength(1);
    expect(new Set(results.map((result) => result.data?.indexingJobId))).toEqual(new Set([QUEUED_JOB_ID]));
  });

  it('F: uses an explicit rootPath instead of the environment’s project', async () => {
    const other = await makeRepository('other');
    harness = await createMcpHarness(
      apiFor({ registered: false, runs: [], runsAfterIndex: [queuedJob()] }),
      { project: currentProject() },
    );

    const { data } = await ensure({ rootPath: other });

    expect(harness.requests[0]).toEqual({ path: '/api/projects/resolve', query: { path: other } });
    expect(indexRequests(harness.requests)[0]?.body).toEqual({ path: other, force: false });
    expect(data).toMatchObject({ rootPath: other, rootSource: 'argument' });
  });

  it('uses the enclosing project when the session is opened inside one', async () => {
    const nested = await makeRepository('app/web');
    harness = await createMcpHarness(apiFor({ registered: true, exact: false, runs: [analysisJob()] }), {
      project: { path: nested, source: 'CLAUDE_PROJECT_DIR' },
    });

    const { data } = await ensure();

    expect(indexRequests(harness.requests)).toEqual([]);
    expect(data).toMatchObject({ projectId: PROJECT_ID, rootPath: repo, requestedPath: nested });
  });

  it('does not retry a failed run automatically', async () => {
    const failed = analysisJob({ status: 'FAILED', error: 'scip-typescript crashed', stats: null });
    harness = await createMcpHarness(apiFor({ registered: true, runs: [failed] }), { project: currentProject() });

    const { data, text } = await ensure();

    expect(indexRequests(harness.requests)).toEqual([]);
    expect(data).toMatchObject({ action: 'none', status: 'failed', error: 'scip-typescript crashed', indexed: false });
    expect(text).toContain('index_project');
  });

  it('does not re-index a graph whose freshness cannot be determined', async () => {
    harness = await createMcpHarness(
      apiFor({
        registered: true,
        runs: [analysisJob()],
        freshness: indexFreshness({ state: 'unknown', reason: 'built before source revisions were recorded' }),
      }),
      { project: currentProject() },
    );

    const { data } = await ensure();

    expect(indexRequests(harness.requests)).toEqual([]);
    expect(data).toMatchObject({ action: 'none', status: 'ready', stale: null });
  });

  it('starts indexing a registered project that was never indexed', async () => {
    harness = await createMcpHarness(
      apiFor({
        registered: true,
        runs: [],
        runsAfterIndex: [queuedJob()],
        indexResult: { projectCreated: false },
      }),
      { project: currentProject() },
    );

    const { data } = await ensure();

    expect(indexRequests(harness.requests)).toHaveLength(1);
    expect(data).toMatchObject({ action: 'started', status: 'indexing', projectCreated: false, indexingStarted: true });
  });

  it('G: fails clearly when there is no current project and no rootPath', async () => {
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), { project: null });

    const { result, text } = await ensure();

    expect(result.isError).toBe(true);
    expect(text).toContain('PROJECT_ROOT_UNDETERMINED');
    expect(text).toContain('CLAUDE_PROJECT_DIR');
    expect(harness.requests).toEqual([]);
  });

  it.each([
    ['a directory that does not exist', () => path.join(scratch, 'missing'), 'PROJECT_ROOT_NOT_FOUND'],
    ['a file', () => path.join(repo, 'package.json'), 'PROJECT_ROOT_NOT_DIRECTORY'],
    ['a directory that is not a project', () => scratch, 'PROJECT_ROOT_NOT_A_PROJECT'],
    ['the filesystem root', () => path.parse(scratch).root, 'PROJECT_ROOT_TOO_BROAD'],
  ])('H: refuses %s without calling the API', async (_label, root, code) => {
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), { project: currentProject() });

    const { result, text } = await ensure({ rootPath: root() });

    expect(result.isError).toBe(true);
    expect(text).toContain(code);
    expect(harness.requests).toEqual([]);
  });

  it('H: refuses an invalid environment root the same way', async () => {
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), {
      project: { path: path.join(scratch, 'gone'), source: 'CLAUDE_PROJECT_DIR' },
    });

    const { result, text } = await ensure();

    expect(result.isError).toBe(true);
    expect(text).toContain('PROJECT_ROOT_NOT_FOUND');
    expect(text).toContain('CLAUDE_PROJECT_DIR');
  });

  it('reports an API that is not running as something to start', async () => {
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), { project: currentProject() });
    await harness.stopApi();

    const { result, text } = await ensure();

    expect(result.isError).toBe(true);
    expect(text).toContain('pnpm dev:all');
  });
});

describe('the startup check', () => {
  it('registers the current project and records the queued run without being asked', async () => {
    harness = await createMcpHarness(
      apiFor({ registered: false, runs: [], runsAfterIndex: [queuedJob()] }),
      { project: currentProject() },
    );

    const outcome = await ensureCurrentProjectOnStartup(harness.runtime, harness.config, silent);

    expect(outcome).toMatchObject({ action: 'registered', indexingJobId: QUEUED_JOB_ID });
  });

  it('does nothing when switched off', async () => {
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), { project: currentProject() });

    const outcome = await ensureCurrentProjectOnStartup(
      harness.runtime,
      { ...harness.config, mcp: { ...harness.config.mcp, MCP_AUTO_ENSURE_PROJECT: false } },
      silent,
    );

    expect(outcome).toBeNull();
    expect(harness.requests).toEqual([]);
  });

  it('does nothing without a current project, and never throws', async () => {
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), { project: null });
    expect(await ensureCurrentProjectOnStartup(harness.runtime, harness.config, silent)).toBeNull();

    await harness.close();
    harness = await createMcpHarness(apiFor({ registered: false, runs: [] }), { project: currentProject() });
    await harness.stopApi();
    const warnings: string[] = [];
    const outcome = await ensureCurrentProjectOnStartup(harness.runtime, harness.config, {
      ...silent,
      warn: (_details, message) => warnings.push(message),
    });

    expect(outcome).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('resolveProjectRoot', () => {
  it('prefers an explicit path, then the environment', async () => {
    const other = await makeRepository('other');
    const hint = { path: repo, source: 'CLAUDE_PROJECT_DIR' as const };

    expect(await resolveProjectRoot({ hint })).toEqual({ rootPath: repo, source: 'CLAUDE_PROJECT_DIR' });
    expect(await resolveProjectRoot({ explicit: other, hint })).toEqual({ rootPath: other, source: 'argument' });
    expect(await resolveProjectRoot({ explicit: '../other', hint })).toEqual({ rootPath: other, source: 'argument' });
  });

  it('normalises and canonicalises the path', async () => {
    const hint = { path: `${repo}/./src/..`, source: 'CODERAG_PROJECT_DIR' as const };

    expect((await resolveProjectRoot({ hint })).rootPath).toBe(repo);
  });

  it('accepts a subdirectory of a git work tree without a manifest of its own', async () => {
    await mkdir(path.join(repo, '.git'));
    await mkdir(path.join(repo, 'src', 'lib'), { recursive: true });

    const resolved = await resolveProjectRoot({ explicit: path.join(repo, 'src', 'lib'), hint: null });

    expect(resolved.rootPath).toBe(path.join(repo, 'src', 'lib'));
  });

  it('refuses the home directory', async () => {
    await expect(resolveProjectRoot({ explicit: repo, hint: null, homeDirectory: repo })).rejects.toMatchObject({
      code: 'PROJECT_ROOT_TOO_BROAD',
    });
  });

  it('refuses a relative path with nothing to resolve it against', async () => {
    await expect(resolveProjectRoot({ explicit: 'src', hint: null })).rejects.toBeInstanceOf(ProjectRootError);
    await expect(
      resolveProjectRoot({ hint: { path: 'relative/dir', source: 'CLAUDE_PROJECT_DIR' } }),
    ).rejects.toMatchObject({ code: 'PROJECT_ROOT_UNDETERMINED' });
  });
});

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };
