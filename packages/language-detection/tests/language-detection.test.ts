import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JavaScriptDetector,
  LanguageDetectionService,
  TypeScriptDetector,
  languageFromPath,
  scanRepository,
} from '@ckg/language-detection';

/** Materialises a repository from a { relativePath: contents } map. */
async function createRepository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ckg-detect-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
  return root;
}

describe('LanguageDetectionService', () => {
  const roots: string[] = [];

  beforeEach(() => {
    roots.length = 0;
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function repository(files: Record<string, string>): Promise<string> {
    const root = await createRepository(files);
    roots.push(root);
    return root;
  }

  it('detects a TypeScript repository', async () => {
    const root = await repository({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{}',
      'src/index.ts': 'export const a = 1;',
      'src/app.tsx': 'export const B = () => null;',
    });

    const result = await new LanguageDetectionService().detect(root);

    expect(result.primaryLanguage).toBe('typescript');
    expect(result.languages).toContain('typescript');
    expect(result.evidence[0]?.markers).toContain('tsconfig.json');
  });

  it('detects a JavaScript repository', async () => {
    const root = await repository({
      'package.json': '{"name":"app"}',
      'src/index.js': 'module.exports = 1;',
      'src/util.mjs': 'export const a = 1;',
    });

    const result = await new LanguageDetectionService().detect(root);

    expect(result.primaryLanguage).toBe('javascript');
    expect(result.languages).toEqual(['javascript']);
  });

  it('prefers TypeScript in a mixed repository but reports both', async () => {
    const root = await repository({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{}',
      'src/index.ts': 'export const a = 1;',
      'scripts/build.js': 'console.log(1);',
    });

    const result = await new LanguageDetectionService().detect(root);

    expect(result.primaryLanguage).toBe('typescript');
    expect(result.languages).toEqual(['typescript', 'javascript']);
  });

  it('reports nothing for a repository with no supported sources', async () => {
    const root = await repository({ 'README.md': '# docs', 'data.csv': 'a,b' });

    const result = await new LanguageDetectionService().detect(root);

    expect(result.languages).toEqual([]);
    expect(result.primaryLanguage).toBeUndefined();
  });

  it('does not treat a lone tsconfig as a TypeScript repository', async () => {
    const root = await repository({ 'tsconfig.json': '{}', 'readme.md': 'x' });

    const result = await new LanguageDetectionService().detect(root);

    expect(result.primaryLanguage).toBeUndefined();
  });

  it('ignores dependency and build directories', async () => {
    const root = await repository({
      'package.json': '{"name":"app"}',
      'src/index.js': 'x',
      'node_modules/dep/index.ts': 'export const a = 1;',
      'dist/bundle.ts': 'export const b = 2;',
    });

    const scan = await scanRepository(root);

    expect(scan.files.some((file) => file.startsWith('node_modules/'))).toBe(false);
    expect(scan.files.some((file) => file.startsWith('dist/'))).toBe(false);
    expect(await new LanguageDetectionService().detect(root)).toMatchObject({
      primaryLanguage: 'javascript',
    });
  });

  it('accepts injected detectors so new languages need no call-site change', async () => {
    const root = await repository({ 'src/index.ts': 'export const a = 1;' });

    const onlyJavaScript = new LanguageDetectionService([new JavaScriptDetector()]);
    expect((await onlyJavaScript.detect(root)).languages).toEqual([]);

    const onlyTypeScript = new LanguageDetectionService([new TypeScriptDetector()]);
    expect((await onlyTypeScript.detect(root)).languages).toEqual(['typescript']);
  });
});

describe('languageFromPath', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.tsx', 'typescript'],
    ['types/a.d.ts', 'typescript'],
    ['src/a.mjs', 'javascript'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['lib/app.dart', 'dart'],
    ['README.md', null],
    ['Makefile', null],
  ])('maps %s to %s', (filePath, expected) => {
    expect(languageFromPath(filePath)).toBe(expected);
  });
});
