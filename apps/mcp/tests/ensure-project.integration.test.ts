import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { captureSourceRevision } from '@ckg/language-detection';
import { createHarness, type Harness } from '../../api/tests/helpers/harness.js';
import type { ProjectDirectoryHint } from '../src/config.js';
import { createMcpRuntime, ensureCurrentProjectOnStartup, type McpRuntime } from '../src/server.js';
import { testConfig } from './helpers/harness.js';

/**
 * The whole lifecycle with nothing stubbed but the worker:
 *
 *   open a repository → start the MCP server → startup check registers it and
 *   queues a run → status says indexing → the run completes → status says
 *   ready and current → another ensure queues nothing
 *
 * The MCP server talks HTTP to the real API application (its in-memory stores
 * standing in for PostgreSQL), which reads a real git repository on disk. That
 * is what makes this the test of the claims that matter — one project per
 * directory, one run at a time, freshness from the real files — rather than of
 * a stub's idea of them. The worker is played by the test: it marks the run
 * completed with the revision the worker would have recorded.
 */

let api: Harness;
let apiBaseUrl: string;
let scratch: string;
const sessions: { client: Client; runtime: McpRuntime }[] = [];

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ckg-ensure-it-')));
  api = await createHarness({ canonicalizePaths: true });
  await api.app.listen({ port: 0, host: '127.0.0.1' });
  apiBaseUrl = `http://127.0.0.1:${String((api.app.server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.client.close();
    await session.runtime.server.close();
  }
  await api.app.close();
  await rm(scratch, { recursive: true, force: true });
});

async function createRepository(relative: string): Promise<string> {
  const repo = path.join(scratch, relative);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'package.json'), '{"name":"sample"}\n');
  await writeFile(path.join(repo, 'src/app.ts'), 'export const a = 1;\n');
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  return repo;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  );
}

/** One MCP server process, as Claude Code would start it for a repository. */
async function startMcp(repo: string | null) {
  const project: ProjectDirectoryHint | null = repo ? { path: repo, source: 'CLAUDE_PROJECT_DIR' } : null;
  const config = testConfig(apiBaseUrl, project);
  const runtime = createMcpRuntime(config);
  const client = new Client({ name: 'integration', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), runtime.server.connect(serverTransport)]);
  sessions.push({ client, runtime });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as Record<string, unknown>;
  };

  return { runtime, config, call };
}

/** What the worker does at the end of a run. */
async function completeRun(repo: string, jobId: string): Promise<void> {
  api.analyses.revisions.set(jobId, await captureSourceRevision(repo));
  api.analyses.complete(jobId);
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

describe('automatic project registration, end to end', () => {
  it('registers and indexes a newly opened repository once, then leaves it alone', async () => {
    const repo = await createRepository('app');

    // Claude Code starts the server; the startup check runs without being asked.
    const mcp = await startMcp(repo);
    const startup = await ensureCurrentProjectOnStartup(mcp.runtime, mcp.config, silent);

    expect(startup).toMatchObject({ action: 'registered', rootPath: repo, status: 'indexing', indexing: true });
    const projectId = startup?.projectId ?? '';
    const jobId = startup?.indexingJobId ?? '';
    expect(api.projects.projects.size).toBe(1);
    expect([...api.analyses.jobs.values()].map((job) => job.id)).toEqual([jobId]);

    // The model asks before the run is done: same project, same run, nothing new.
    expect(await mcp.call('ensure_project')).toMatchObject({
      projectId,
      action: 'already_indexing',
      indexingJobId: jobId,
    });
    expect(await mcp.call('get_index_status', { projectId })).toMatchObject({
      state: 'indexing',
      indexingJobId: jobId,
    });

    await completeRun(repo, jobId);

    expect(await mcp.call('get_index_status', { projectId })).toMatchObject({
      state: 'ready',
      freshness: 'current',
      stale: false,
    });

    // A later session in the same repository: registration and graph reused.
    const later = await startMcp(repo);
    expect(await ensureCurrentProjectOnStartup(later.runtime, later.config, silent)).toMatchObject({
      projectId,
      action: 'up_to_date',
      status: 'ready',
      indexingStarted: false,
    });
    expect(await later.call('ensure_project')).toMatchObject({ projectId, action: 'up_to_date' });
    expect(api.projects.projects.size).toBe(1);
    expect(api.analyses.jobs.size).toBe(1);
  });

  it('re-indexes a stale repository once, and reports the run to later callers', async () => {
    const repo = await createRepository('app');
    const mcp = await startMcp(repo);
    const first = await mcp.call('ensure_project');
    await completeRun(repo, String(first.indexingJobId));

    await writeFile(path.join(repo, 'src/app.ts'), 'export const a = 2;\n');

    const stale = await mcp.call('ensure_project');
    expect(stale).toMatchObject({
      projectId: first.projectId,
      action: 'started',
      status: 'indexing',
      stale: true,
      changedFiles: 1,
      changedPaths: ['src/app.ts'],
      indexed: true,
    });
    expect(api.analyses.jobs.size).toBe(2);

    expect(await mcp.call('ensure_project')).toMatchObject({
      action: 'already_indexing',
      indexingJobId: stale.indexingJobId,
    });
    expect(api.analyses.jobs.size).toBe(2);
  });

  it('E: sessions starting together register one project and queue one run', async () => {
    const repo = await createRepository('app');
    // Widen the window between "is anything registered here?" and acting on
    // the answer, as a real database round trip would.
    const listAll = api.repositories.listAll.bind(api.repositories);
    api.repositories.listAll = async () => {
      const result = await listAll();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    };

    const sessionsTogether = await Promise.all([startMcp(repo), startMcp(repo), startMcp(repo)]);
    // Two calls per session: within a session they share one check, across
    // sessions the API serialises them.
    const perSession = await Promise.all(
      sessionsTogether.map((session) => Promise.all([session.call('ensure_project'), session.call('ensure_project')])),
    );
    const outcomes = perSession.flat();

    expect(api.projects.projects.size).toBe(1);
    expect(api.analyses.jobs.size).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.projectId)).size).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.indexingJobId)).size).toBe(1);
    expect(perSession.filter(([outcome]) => outcome?.projectCreated)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.action === 'already_indexing')).toHaveLength(4);
  });

  it('F: an explicit rootPath wins over the session’s project', async () => {
    const opened = await createRepository('opened');
    const other = await createRepository('other');
    const mcp = await startMcp(opened);

    const outcome = await mcp.call('ensure_project', { rootPath: other });

    expect(outcome).toMatchObject({ rootPath: other, rootSource: 'argument', action: 'registered' });
    expect([...api.repositories.byProject.values()].map((repository) => repository.sourcePath)).toEqual([other]);
  });

  it('I: two repositories with the same directory name stay separate projects', async () => {
    const first = await createRepository('team-a/my-app');
    const second = await createRepository('team-b/my-app');

    const a = await (await startMcp(first)).call('ensure_project');
    const b = await (await startMcp(second)).call('ensure_project');

    expect(a.projectId).not.toBe(b.projectId);
    expect(a).toMatchObject({ projectName: 'my-app', rootPath: first, action: 'registered' });
    expect(b).toMatchObject({ projectName: 'my-app', rootPath: second, action: 'registered' });
    expect(api.projects.projects.size).toBe(2);

    // And each resolves back to its own.
    const session = await startMcp(first);
    expect(await session.call('ensure_project')).toMatchObject({ projectId: a.projectId, action: 'already_indexing' });
  });

  it('G: with no project in the environment, the startup check does nothing and the tool says why', async () => {
    const mcp = await startMcp(null);

    expect(await ensureCurrentProjectOnStartup(mcp.runtime, mcp.config, silent)).toBeNull();
    await expect(mcp.call('ensure_project')).rejects.toThrow(/PROJECT_ROOT_UNDETERMINED/);
    expect(api.projects.projects.size).toBe(0);
  });
});
