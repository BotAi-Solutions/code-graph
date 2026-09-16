import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySourceFileSet, loadSourceFiles, moduleSetFor } from '../src/index.js';

/**
 * What happens to a run when one file will not cooperate.
 *
 * The rule the whole pipeline is built on is that a repository with a broken
 * file in it still deserves a graph of everything else. So a file that cannot be
 * read or parsed is *recorded* and skipped — never thrown, never silently
 * dropped, and never a reason for the other nine hundred files to go unindexed.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ckg-resilience-'));
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

describe('loadSourceFiles', () => {
  it('reads what it can and names what it could not', async () => {
    await tree({
      'src/good.ts': 'export const ok = 1;',
      'src/also-good.ts': 'export const fine = 2;',
      'src/locked.ts': 'export const secret = 3;',
    });
    await chmod(path.join(root, 'src/locked.ts'), 0o000);

    try {
      const sources = await loadSourceFiles(root);

      expect(sources.all().map((file) => file.relativePath)).toEqual([
        'src/also-good.ts',
        'src/good.ts',
      ]);
      expect(sources.failures).toHaveLength(1);
      expect(sources.failures[0]?.file).toBe('src/locked.ts');
      expect(sources.failures[0]?.error).toContain('EACCES');
    } finally {
      await chmod(path.join(root, 'src/locked.ts'), 0o644);
    }
  });

  it('reports no failures when every file reads', async () => {
    await tree({ 'src/a.ts': 'export {};', 'src/b.ts': 'export {};' });

    const sources = await loadSourceFiles(root);

    expect(sources.failures).toEqual([]);
  });

  it('reports files read against a real total', async () => {
    await tree(
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/f${String(i)}.ts`, 'export {};'])),
    );

    const seen: Array<[number, number]> = [];
    const sources = await loadSourceFiles(root, {
      onProgress: (read, total) => seen.push([read, total]),
    });

    expect(seen.at(-1)).toEqual([sources.all().length, sources.all().length]);
    for (const [read, total] of seen) expect(read).toBeLessThanOrEqual(total);
  });

  it('reuses a walk it is handed rather than walking again', async () => {
    await tree({ 'src/a.ts': 'export {};', 'src/b.ts': 'export {};' });

    // A scan that saw only one of the two files: if the loader walked again it
    // would find both, so finding one proves the scan was the input.
    const sources = await loadSourceFiles(root, {
      scan: {
        rootPath: root,
        files: ['src/a.ts'],
        rootFiles: new Set<string>(),
        extensionCounts: new Map(),
        directoryCount: 1,
        truncated: false,
      },
    });

    expect(sources.all().map((file) => file.relativePath)).toEqual(['src/a.ts']);
  });
});

describe('the parsed module set', () => {
  it('parses the files it can and keeps going past the ones it cannot', () => {
    // The compiler's parser recovers from almost anything, which is why this is
    // a real file with real broken syntax rather than something contrived: it
    // must be *analysed*, not rejected.
    const sources = new InMemorySourceFileSet([
      { relativePath: 'src/good.ts', text: 'export class Good { run() {} }' },
      { relativePath: 'src/broken.ts', text: 'export class {{{ ¯\\_(ツ)_/¯ function( ' },
      { relativePath: 'src/after.ts', text: 'export class After { run() {} }' },
    ]);

    const modules = moduleSetFor(sources);
    const parsed = [...modules.modules()].map((module) => module.relativePath);

    // Whatever the parser made of the broken file, the two good ones are there.
    expect(parsed).toContain('src/good.ts');
    expect(parsed).toContain('src/after.ts');
    // And nothing threw: reaching this line is the assertion.
    expect(modules.failures().every((failure) => typeof failure.error === 'string')).toBe(true);
  });

  it('records a file whose parse throws, once, and does not retry it', () => {
    const sources = new InMemorySourceFileSet([
      { relativePath: 'src/ok.ts', text: 'export const a = 1;' },
      // A getter that throws stands in for a parser failure, which the
      // TypeScript parser is too forgiving to produce on demand. What is under
      // test is the handling, not the trigger.
      {
        relativePath: 'src/explodes.ts',
        get text(): string {
          throw new Error('cannot decode this file');
        },
      },
    ]);

    const modules = moduleSetFor(sources);
    const parsed = [...modules.modules()].map((module) => module.relativePath);

    expect(parsed).toEqual(['src/ok.ts']);
    expect(modules.failures()).toEqual([
      { file: 'src/explodes.ts', error: 'cannot decode this file' },
    ]);

    // Asked again, it is still one failure — the result is cached, not retried.
    expect(modules.module('src/explodes.ts')).toBeUndefined();
    expect(modules.failures()).toHaveLength(1);
  });
});
