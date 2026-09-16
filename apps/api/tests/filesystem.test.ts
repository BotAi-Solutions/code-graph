import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  DirectoryListing,
  ProjectMetadata,
  SelectedDirectory,
} from '@ckg/shared';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config/index.js';
import { AnalysisService } from '../src/modules/analysis/index.js';
import {
  DirectoryPickerUnavailableError,
  FilesystemService,
  NativeDirectoryPicker,
  type DirectoryPicker,
} from '../src/modules/filesystem/index.js';
import { GraphService } from '../src/modules/graph/index.js';
import { HealthService } from '../src/modules/health/index.js';
import { ProjectService } from '../src/modules/projects/index.js';
import { RepositoryService } from '../src/modules/repositories/index.js';
import {
  InMemoryAnalysisJobStore,
  InMemoryGraphStore,
  InMemoryProjectStore,
  InMemoryRepositoryStore,
  StubHealthProbe,
} from './helpers/in-memory-stores.js';

/**
 * The local project intake boundary.
 *
 * Exercised through the HTTP layer rather than against the service directly:
 * the contract this feature has to keep is the wire one — what the browser asks
 * for and what comes back — and the routes, the schemas and the error mapping
 * are as much a part of that as the service is.
 *
 * The one thing genuinely outside the process, the OS folder dialog, is a stub.
 * `NativeDirectoryPicker`'s own platform logic is checked separately, without
 * ever opening a window.
 */

const CONFIG: ApiConfig = {
  runtime: { NODE_ENV: 'test', LOG_LEVEL: 'error' },
  database: { DATABASE_URL: 'postgresql://unused', DATABASE_POOL_MAX: 1 },
  http: { PORT: 0, HOST: '127.0.0.1', CORS_ORIGIN: '*', corsOrigins: ['*'] },
  filesystem: { LOCAL_FILESYSTEM_ENABLED: true, DIRECTORY_PICKER_TIMEOUT_MS: 1000 },
};

class StubPicker implements DirectoryPicker {
  calls = 0;

  constructor(private readonly behaviour: () => string | null) {}

  isAvailable(): boolean {
    return true;
  }

  async pick(): Promise<string | null> {
    this.calls += 1;
    return this.behaviour();
  }
}

class MissingPicker implements DirectoryPicker {
  isAvailable(): boolean {
    return false;
  }
  async pick(): Promise<never> {
    throw new DirectoryPickerUnavailableError('no native folder dialog is available on sunos');
  }
}

async function createApp(options: {
  picker: DirectoryPicker;
  enabled?: boolean;
  homeDirectory?: string;
}): Promise<FastifyInstance> {
  const projectStore = new InMemoryProjectStore();
  const repositoryStore = new InMemoryRepositoryStore();
  const analysisStore = new InMemoryAnalysisJobStore();
  const graphStore = new InMemoryGraphStore();

  const projects = new ProjectService(projectStore);
  const repositories = new RepositoryService(repositoryStore, projects);

  const app = await buildApp({
    config: CONFIG,
    services: {
      filesystem: new FilesystemService({
        enabled: options.enabled ?? true,
        picker: options.picker,
        pickerTimeoutMs: 1000,
        ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
      }),
      projects,
      repositories,
      analysis: new AnalysisService(analysisStore, projects, repositories),
      graph: new GraphService(graphStore, projects),
      health: new HealthService(new StubHealthProbe(true)),
    },
  });

  await app.ready();
  return app;
}

function body<T>(response: { body: string }): ApiResponse<T> {
  return JSON.parse(response.body) as ApiResponse<T>;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ckg-fs-api-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
}

describe('POST /api/filesystem/select-directory', () => {
  it('returns the folder the user chose, by path and by name', async () => {
    const app = await createApp({ picker: new StubPicker(() => root) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/filesystem/select-directory',
    });

    expect(response.statusCode).toBe(200);
    const data = body<SelectedDirectory>(response).data;
    expect(data).toEqual({ path: root, name: path.basename(root) });

    await app.close();
  });

  it('treats a dismissed dialog as success with no selection, not as an error', async () => {
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/filesystem/select-directory',
    });

    expect(response.statusCode).toBe(200);
    expect(body<SelectedDirectory | null>(response).data).toBeNull();

    await app.close();
  });

  it('says 501 when the host has no dialog, so the UI can offer the browser', async () => {
    const app = await createApp({ picker: new MissingPicker() });

    const response = await app.inject({
      method: 'POST',
      url: '/api/filesystem/select-directory',
    });

    expect(response.statusCode).toBe(501);
    const payload = body(response);
    expect(payload.success).toBe(false);
    if (!payload.success) expect(payload.error.code).toBe('DIRECTORY_PICKER_UNAVAILABLE');

    await app.close();
  });

  it('refuses when local filesystem access is switched off', async () => {
    const app = await createApp({ picker: new StubPicker(() => root), enabled: false });

    for (const request of [
      { method: 'POST' as const, url: '/api/filesystem/select-directory' },
      { method: 'GET' as const, url: '/api/filesystem/directories' },
      { method: 'GET' as const, url: `/api/filesystem/project?path=${encodeURIComponent(root)}` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
      const payload = body(response);
      if (!payload.success) expect(payload.error.code).toBe('FILESYSTEM_ACCESS_DISABLED');
    }

    await app.close();
  });
});

describe('GET /api/filesystem/directories', () => {
  it('lists subdirectories and never files', async () => {
    await tree({
      'apps/api/package.json': '{}',
      'packages/shared/index.ts': '',
      'README.md': '# root',
      'notes.txt': '',
    });
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(root)}`,
    });

    expect(response.statusCode).toBe(200);
    const listing = body<DirectoryListing>(response).data as DirectoryListing;

    expect(listing.entries.map((entry) => entry.name)).toEqual(['apps', 'packages']);
    expect(JSON.stringify(listing)).not.toContain('README.md');
    expect(JSON.stringify(listing)).not.toContain('notes.txt');

    await app.close();
  });

  it('hides ignored and hidden directories', async () => {
    await tree({
      'src/app.ts': '',
      'node_modules/thing/index.js': '',
      'dist/app.js': '',
      '.git/HEAD': '',
      '.secrets/key': '',
    });
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(root)}`,
    });

    const listing = body<DirectoryListing>(response).data as DirectoryListing;
    expect(listing.entries.map((entry) => entry.name)).toEqual(['src']);

    await app.close();
  });

  it('marks which entries are project roots, and whether this one is', async () => {
    await tree({
      'package.json': '{"name":"root"}',
      'a-service/go.mod': 'module example.com/a',
      'b-notes/notes.md': '',
    });
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(root)}`,
    });

    const listing = body<DirectoryListing>(response).data as DirectoryListing;
    expect(listing.isProjectRoot).toBe(true);
    expect(listing.entries).toEqual([
      { name: 'a-service', path: path.join(root, 'a-service'), isProjectRoot: true },
      { name: 'b-notes', path: path.join(root, 'b-notes'), isProjectRoot: false },
    ]);

    await app.close();
  });

  it('offers the parent, and null at a filesystem root', async () => {
    const app = await createApp({ picker: new StubPicker(() => null) });

    const inner = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(root)}`,
    });
    expect((body<DirectoryListing>(inner).data as DirectoryListing).parentPath).toBe(
      path.dirname(root),
    );

    const top = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(path.parse(root).root)}`,
    });
    expect((body<DirectoryListing>(top).data as DirectoryListing).parentPath).toBeNull();

    await app.close();
  });

  it('starts in the home directory when given no path', async () => {
    await tree({ 'projects/app/package.json': '{}' });
    const app = await createApp({ picker: new StubPicker(() => null), homeDirectory: root });

    const response = await app.inject({ method: 'GET', url: '/api/filesystem/directories' });

    expect((body<DirectoryListing>(response).data as DirectoryListing).path).toBe(root);

    await app.close();
  });

  it('reports a missing directory as 404 and a file as a bad path', async () => {
    await tree({ 'app.ts': '' });
    const app = await createApp({ picker: new StubPicker(() => null) });

    const missing = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(path.join(root, 'nope'))}`,
    });
    expect(missing.statusCode).toBe(404);

    const file = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent(path.join(root, 'app.ts'))}`,
    });
    expect(file.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a path carrying a NUL byte before it reaches the filesystem', async () => {
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'GET',
      url: `/api/filesystem/directories?path=${encodeURIComponent('/tmp/ /etc')}`,
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /api/filesystem/project', () => {
  it('reports what one walk of the directory established', async () => {
    await tree({
      'src/index.ts': '',
      'src/app.tsx': '',
      'scripts/build.js': '',
      'tools/gen.py': '',
      'README.md': '',
      'node_modules/thing/index.js': '',
      'pnpm-lock.yaml': '',
    });
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'GET',
      url: `/api/filesystem/project?path=${encodeURIComponent(root)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(body<ProjectMetadata>(response).data).toEqual({
      rootPath: root,
      name: path.basename(root),
      totalFiles: 5,
      sourceFiles: 4,
      languages: { typescript: 2, javascript: 1, python: 1 },
      directories: 3,
      truncated: false,
    });

    await app.close();
  });

  it('says so when a folder holds no source we support', async () => {
    await tree({ 'notes.md': '', 'photo.png': '' });
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({
      method: 'GET',
      url: `/api/filesystem/project?path=${encodeURIComponent(root)}`,
    });

    expect(response.statusCode).toBe(422);
    const payload = body(response);
    if (!payload.success) {
      expect(payload.error.code).toBe('NO_SOURCE_FILES');
      expect(payload.error.message).toContain('No supported source files');
    }

    await app.close();
  });

  it('reports a directory it cannot read as permission denied', async () => {
    const locked = path.join(root, 'locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'app.ts'), '');
    await chmod(locked, 0o000);

    const app = await createApp({ picker: new StubPicker(() => null) });

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/filesystem/project?path=${encodeURIComponent(locked)}`,
      });

      expect(response.statusCode).toBe(403);
      const payload = body(response);
      if (!payload.success) {
        expect(payload.error.code).toBe('DIRECTORY_NOT_READABLE');
        expect(payload.error.message).toBe('Permission denied while accessing the project.');
      }
    } finally {
      await chmod(locked, 0o755);
      await app.close();
    }
  });

  it('requires a path', async () => {
    const app = await createApp({ picker: new StubPicker(() => null) });

    const response = await app.inject({ method: 'GET', url: '/api/filesystem/project' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('NativeDirectoryPicker', () => {
  it('has a dialog on macOS and Windows without asking the environment', () => {
    expect(new NativeDirectoryPicker('darwin', {}).isAvailable()).toBe(true);
    expect(new NativeDirectoryPicker('win32', {}).isAvailable()).toBe(true);
  });

  it('needs a display on Linux, and never claims one it does not have', () => {
    expect(new NativeDirectoryPicker('linux', {}).isAvailable()).toBe(false);
    expect(new NativeDirectoryPicker('linux', { DISPLAY: ':0' }).isAvailable()).toBe(true);
    expect(
      new NativeDirectoryPicker('linux', { WAYLAND_DISPLAY: 'wayland-0' }).isAvailable(),
    ).toBe(true);
  });

  it('refuses rather than guessing on a platform it does not know', async () => {
    const picker = new NativeDirectoryPicker('sunos' as NodeJS.Platform, {});

    expect(picker.isAvailable()).toBe(false);
    await expect(picker.pick({ timeoutMs: 10 })).rejects.toBeInstanceOf(
      DirectoryPickerUnavailableError,
    );
  });
});

describe('the OpenAPI document', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp({ picker: new StubPicker(() => null) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every intake route', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    const document = JSON.parse(response.body) as { paths: Record<string, unknown> };

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/filesystem/select-directory',
        '/api/filesystem/directories',
        '/api/filesystem/project',
      ]),
    );
  });
});
