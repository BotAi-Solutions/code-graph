import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IGNORED_DIRECTORIES,
  IgnoreRules,
  ProjectScanError,
  detectLanguage,
  resolveProjectRoot,
  scanProject,
  scanRepository,
  summarizeScan,
} from '../src/index.js';

/**
 * The scanner against a real directory tree rather than a fake filesystem.
 *
 * Walking a directory is the one thing here that is *entirely* I/O — there is no
 * interesting pure core to extract — so a fake would only be testing the fake.
 * Each case builds the tree it needs in a temporary directory and throws it
 * away afterwards.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ckg-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes `files` as a tree under the scan root, creating directories as needed. */
async function tree(files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
}

describe('scanProject', () => {
  it('walks nested directories to the bottom', async () => {
    await tree({
      'src/index.ts': 'export {};',
      'src/services/user/user.service.ts': 'export class UserService {}',
      'src/services/user/dto/user.dto.ts': 'export interface User {}',
      'README.md': '# sample',
    });

    const { metadata, scan } = await scanProject(root);

    expect(scan.files).toEqual([
      'README.md',
      'src/index.ts',
      'src/services/user/dto/user.dto.ts',
      'src/services/user/user.service.ts',
    ]);
    expect(metadata.totalFiles).toBe(4);
    expect(metadata.sourceFiles).toBe(3);
    // src, src/services, src/services/user, src/services/user/dto
    expect(metadata.directories).toBe(4);
    expect(metadata.name).toBe(path.basename(root));
    expect(metadata.rootPath).toBe(root);
  });

  it('never descends into an ignored directory', async () => {
    await tree({
      'src/app.ts': 'export {};',
      'node_modules/left-pad/index.js': 'module.exports = 1;',
      'node_modules/.bin/thing': '#!/bin/sh',
      'dist/app.js': 'var a = 1;',
      'build/app.js': 'var a = 1;',
      'coverage/lcov.info': 'TN:',
      '.git/HEAD': 'ref: refs/heads/main',
      '.next/trace': '{}',
      'target/debug/app': 'binary',
      'vendor/lib/thing.go': 'package lib',
      '.dart_tool/package_config.json': '{}',
      '__pycache__/mod.cpython-311.pyc': 'x',
      '.idea/workspace.xml': '<xml/>',
      '.vscode/settings.json': '{}',
      '.cache/thing': 'x',
    });

    const { metadata, scan } = await scanProject(root);

    expect(scan.files).toEqual(['src/app.ts']);
    expect(metadata.totalFiles).toBe(1);
    // Only `src`: an ignored directory is not walked *and* not counted.
    expect(metadata.directories).toBe(1);
  });

  it('skips lock files and generated output wherever they sit', async () => {
    await tree({
      'src/app.ts': 'export {};',
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'package-lock.json': '{}',
      'yarn.lock': '# yarn',
      'Cargo.lock': '[[package]]',
      'poetry.lock': '[[package]]',
      'go.sum': 'example.com v1.0.0',
      'packages/thing/composer.lock': '{}',
      'src/vendor.min.js': 'var a=1',
      'src/app.js.map': '{}',
      'package.json': '{"name":"sample"}',
    });

    const { scan } = await scanProject(root);

    expect(scan.files).toEqual(['package.json', 'src/app.ts']);
  });

  it('skips unsupported file types without failing', async () => {
    await tree({
      'src/app.ts': 'export {};',
      'assets/logo.png': 'not really a png',
      'data/rows.csv': 'a,b,c',
      'docs/guide.md': '# guide',
      'legacy/prog.f90': 'program main',
    });

    const { metadata } = await scanProject(root);

    // Every file is seen; only the ones we can detect count as source.
    expect(metadata.totalFiles).toBe(5);
    expect(metadata.sourceFiles).toBe(1);
    expect(metadata.languages).toEqual({ typescript: 1 });
  });

  it('counts source files per language, highest first when ranked', async () => {
    await tree({
      'a.ts': '', 'b.ts': '', 'c.tsx': '',
      'd.js': '', 'e.jsx': '',
      'f.py': '',
      'g.go': '',
      'h.java': '',
      'i.dart': '',
      'notes.txt': '',
    });

    const { metadata } = await scanProject(root);

    expect(metadata.languages).toEqual({
      typescript: 3,
      javascript: 2,
      python: 1,
      go: 1,
      java: 1,
      dart: 1,
    });
  });

  it('reports an empty project as empty rather than failing', async () => {
    const { metadata } = await scanProject(root);

    expect(metadata.totalFiles).toBe(0);
    expect(metadata.sourceFiles).toBe(0);
    expect(metadata.directories).toBe(0);
    expect(metadata.languages).toEqual({});
    expect(metadata.truncated).toBe(false);
  });

  it('reports a project with only ignored content as empty', async () => {
    await tree({ 'node_modules/thing/index.js': '', 'pnpm-lock.yaml': '' });

    const { metadata } = await scanProject(root);

    expect(metadata.totalFiles).toBe(0);
    expect(metadata.sourceFiles).toBe(0);
  });

  it('marks the scan truncated when it hits its file cap, and counts no further', async () => {
    await tree(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/f${String(i)}.ts`, ''])));

    const { metadata } = await scanProject(root, { maxFiles: 5 });

    expect(metadata.totalFiles).toBe(5);
    expect(metadata.truncated).toBe(true);
  });

  it('reports files as it goes, and always ends on the final count', async () => {
    await tree(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`src/f${String(i)}.ts`, ''])));

    const seen: number[] = [];
    const { metadata } = await scanProject(root, {
      progressInterval: 2,
      onProgress: (files) => seen.push(files),
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(metadata.totalFiles);
    // Monotonic: a count of files seen can only go up.
    expect([...seen]).toEqual([...seen].sort((a, b) => a - b));
  });

  it('is deterministic: two scans of one tree agree exactly', async () => {
    await tree({ 'src/b.ts': '', 'src/a.ts': '', 'lib/c.js': '' });

    const first = await scanProject(root);
    const second = await scanProject(root);

    expect(second.scan.files).toEqual(first.scan.files);
    expect(second.metadata).toEqual(first.metadata);
  });
});

describe('the root a project is scanned from', () => {
  it('rejects a path that does not exist', async () => {
    await expect(resolveProjectRoot(path.join(root, 'nope'))).rejects.toMatchObject({
      name: 'ProjectScanError',
      reason: 'not-found',
    });
  });

  it('rejects a file offered as a project', async () => {
    await tree({ 'app.ts': '' });

    await expect(resolveProjectRoot(path.join(root, 'app.ts'))).rejects.toBeInstanceOf(
      ProjectScanError,
    );
    await expect(resolveProjectRoot(path.join(root, 'app.ts'))).rejects.toMatchObject({
      reason: 'not-a-directory',
    });
  });

  it('resolves a relative path against the working directory', async () => {
    const resolved = await resolveProjectRoot('.');
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('skips a subdirectory it cannot read rather than failing the walk', async () => {
    await tree({ 'src/app.ts': '', 'locked/secret.ts': '' });
    // 0o000: present in the listing, unreadable when opened.
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(root, 'locked'), 0o000);

    try {
      const { metadata, scan } = await scanProject(root);
      expect(scan.files).toEqual(['src/app.ts']);
      expect(metadata.sourceFiles).toBe(1);
    } finally {
      await chmod(path.join(root, 'locked'), 0o755);
    }
  });
});

describe('the ignore policy', () => {
  it('is extensible without replacing the defaults', () => {
    const rules = new IgnoreRules({ extraIgnoredDirectories: ['generated'] });

    expect(rules.ignoresDirectory('generated')).toBe(true);
    expect(rules.ignoresDirectory('node_modules')).toBe(true);
    expect(rules.ignoresDirectory('src')).toBe(false);
  });

  it('can be replaced outright when a caller wants its own list', () => {
    const rules = new IgnoreRules({ ignoredDirectories: ['only-this'] });

    expect(rules.ignoresDirectory('only-this')).toBe(true);
    expect(rules.ignoresDirectory('node_modules')).toBe(false);
  });

  it('matches directory and file names case-insensitively', () => {
    const rules = new IgnoreRules();

    expect(rules.ignoresDirectory('Node_Modules')).toBe(true);
    expect(rules.ignoresFile('Gemfile.lock')).toBe(true);
  });

  it('is applied by the walk itself', async () => {
    await tree({ 'src/app.ts': '', 'generated/api.ts': '' });

    const scan = await scanRepository(root, { extraIgnoredDirectories: ['generated'] });

    expect(scan.files).toEqual(['src/app.ts']);
  });

  it('names every directory the default list is documented to skip', () => {
    for (const directory of ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache',
      '.next', '.nuxt', 'target', 'vendor', '.dart_tool', '.idea', '.vscode', '__pycache__']) {
      expect(DEFAULT_IGNORED_DIRECTORIES).toContain(directory);
    }
  });
});

describe('detectLanguage', () => {
  it('maps every initially supported extension', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('src/a.tsx')).toBe('typescript');
    expect(detectLanguage('src/a.d.ts')).toBe('typescript');
    expect(detectLanguage('src/a.js')).toBe('javascript');
    expect(detectLanguage('src/a.jsx')).toBe('javascript');
    expect(detectLanguage('src/a.py')).toBe('python');
    expect(detectLanguage('src/a.go')).toBe('go');
    expect(detectLanguage('src/a.java')).toBe('java');
    expect(detectLanguage('src/a.dart')).toBe('dart');
  });

  it('returns null for a file type we do not support', () => {
    expect(detectLanguage('assets/logo.png')).toBeNull();
    expect(detectLanguage('LICENSE')).toBeNull();
    expect(detectLanguage('.gitignore')).toBeNull();
  });
});

describe('summarizeScan', () => {
  const scan = {
    rootPath: '/projects/sample',
    files: ['src/a.ts', 'src/b.py', 'README.md'],
    rootFiles: new Set(['readme.md']),
    extensionCounts: new Map([['.ts', 1], ['.py', 1], ['.md', 1]]),
    categoryCounts: new Map([
      ['code', 2],
      ['document', 1],
    ] as const),
    directoryCount: 1,
    truncated: false,
  };

  it('is pure: the same scan always summarises the same way', () => {
    expect(summarizeScan(scan)).toEqual({
      rootPath: '/projects/sample',
      name: 'sample',
      totalFiles: 3,
      sourceFiles: 2,
      languages: { typescript: 1, python: 1 },
      fileCategories: { code: 2, document: 1 },
      directories: 1,
      truncated: false,
    });
    expect(summarizeScan(scan)).toEqual(summarizeScan(scan));
  });

  it('recomputes categories from the paths when the walk did not count them', () => {
    const { categoryCounts: _ignored, ...withoutCounts } = scan;

    expect(summarizeScan(withoutCounts as typeof scan).fileCategories).toEqual({
      code: 2,
      document: 1,
    });
  });

  it('keeps sourceFiles meaning "files an indexer could compile"', () => {
    // A repository that is mostly documentation and configuration still reports
    // only its compilable files as source, and says what the rest are.
    const docs = {
      ...scan,
      files: ['README.md', 'docs/architecture.md', 'openapi.yaml', 'src/index.ts'],
      categoryCounts: new Map([
        ['document', 2],
        ['schema', 1],
        ['code', 1],
      ] as const),
    };

    const summary = summarizeScan(docs);
    expect(summary.sourceFiles).toBe(1);
    expect(summary.totalFiles).toBe(4);
    expect(summary.fileCategories).toEqual({ code: 1, document: 2, schema: 1 });
  });
});
