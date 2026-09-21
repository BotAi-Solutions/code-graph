import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodeNode, SourceWindow } from '@ckg/shared';
import {
  ERROR_CODES,
  SOURCE_DEFAULT_CONTEXT_LINES,
  SOURCE_MAX_FILE_BYTES,
  SOURCE_MAX_LINES,
} from '@ckg/shared';
import { AppError } from '../../common/errors/index.js';
import {
  contains,
  SourceRoots,
  type SourceRepositoryResolver,
  type SourceRootOptions,
} from './source-root.js';

/**
 * Reading source back out of an indexed repository.
 *
 * This is the one place in the API that opens a file, and it is deliberately
 * the narrowest thing that could work: a window onto a file *inside a
 * repository the user themselves registered for this project*, read-only, and
 * addressed by a repository-relative path.
 *
 * Three rules keep it that way, and all three live here rather than in a
 * handler:
 *
 * 1. **The root comes from the project, never from the request.** A caller says
 *    `src/services/CareerService.ts`; which disk that lands on is decided by
 *    the repository record attached to the project.
 * 2. **The resolved path is checked against the root twice** — once after
 *    normalising, and again after resolving symlinks, because a link inside the
 *    tree is a perfectly ordinary way to point at `/etc/passwd`.
 * 3. **Nothing about the host's layout is returned.** Responses carry the
 *    repository-relative path the caller asked for, so the browser never learns
 *    where the repository sits.
 */

export interface SourceNodeResolver {
  getNode(projectId: string, nodeId: string): Promise<CodeNode>;
}

export type SourceServiceOptions = SourceRootOptions;

export interface SourceRequest {
  projectId: string;
  file?: string | undefined;
  nodeId?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  context?: number | undefined;
}

/** A range the caller cares about, before it is widened by context. */
interface Highlight {
  nodeId: string | null;
  startLine: number;
  startCharacter: number | null;
  endLine: number;
  endCharacter: number | null;
}

export class SourceService {
  private readonly roots: SourceRoots;

  constructor(
    repositories: SourceRepositoryResolver,
    private readonly nodes: SourceNodeResolver,
    options: SourceServiceOptions,
  ) {
    this.roots = new SourceRoots(repositories, options);
  }

  async read(request: SourceRequest): Promise<SourceWindow> {
    this.roots.assertEnabled();

    const { relativePath, highlight } = await this.locate(request);
    const root = await this.roots.resolve(request.projectId);
    const absolute = await this.resolveWithinRepository(root, relativePath);

    const contents = await this.readFile(absolute, relativePath);
    // `split` on a trailing newline yields a final empty element, which is a
    // line that does not exist. Every other empty line is real and stays.
    const all = contents.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const totalLines = all.length;

    const window = this.windowFor(request, highlight, totalLines);

    const lines = all
      .slice(window.startLine - 1, window.endLine)
      .map((text, offset) => ({ line: window.startLine + offset, text }));

    return {
      file: relativePath,
      language: languageOf(relativePath),
      startLine: window.startLine,
      endLine: window.startLine + Math.max(lines.length - 1, 0),
      totalLines,
      truncated: window.truncated,
      highlight,
      lines,
    };
  }

  /**
   * Which file, and which range within it.
   *
   * A node id supplies both, which is what makes "show me this symbol" a single
   * request. An explicit `file` wins over the node's own path when both are
   * given, so a caller can read a different file at a symbol's line.
   */
  private async locate(
    request: SourceRequest,
  ): Promise<{ relativePath: string; highlight: Highlight | null }> {
    if (request.nodeId === undefined) {
      // The schema guarantees one of the two is present.
      return { relativePath: normalizeRelative(request.file as string), highlight: null };
    }

    const node = await this.nodes.getNode(request.projectId, request.nodeId);
    const filePath = request.file ?? node.filePath;

    if (filePath === undefined) {
      throw new AppError(
        ERROR_CODES.SOURCE_FILE_NOT_FOUND,
        `Graph node ${request.nodeId} has no source file`,
        { context: { nodeId: request.nodeId, type: node.type } },
      );
    }

    const highlight: Highlight | null =
      node.startLine === undefined
        ? null
        : {
            nodeId: node.id,
            startLine: node.startLine,
            startCharacter: node.startCharacter ?? null,
            endLine: node.endLine ?? node.startLine,
            endCharacter: node.endCharacter ?? null,
          };

    return { relativePath: normalizeRelative(filePath), highlight };
  }

  /**
   * The line range to return.
   *
   * An explicit range is honoured as given. A node's range is padded by
   * `context` lines either side, because a method read with no surroundings is
   * harder to place than one read with its neighbours. With neither, the file
   * is returned from the top, up to the response ceiling.
   */
  private windowFor(
    request: SourceRequest,
    highlight: Highlight | null,
    totalLines: number,
  ): { startLine: number; endLine: number; truncated: boolean } {
    const context = request.context ?? SOURCE_DEFAULT_CONTEXT_LINES;

    let start: number;
    let end: number;

    if (request.startLine !== undefined || request.endLine !== undefined) {
      start = request.startLine ?? 1;
      end = request.endLine ?? totalLines;
    } else if (highlight) {
      start = highlight.startLine - context;
      end = highlight.endLine + context;
    } else {
      start = 1;
      end = totalLines;
    }

    start = Math.max(1, Math.min(start, Math.max(totalLines, 1)));
    end = Math.max(start, Math.min(end, totalLines));

    const requested = end - start + 1;
    const truncated = requested > SOURCE_MAX_LINES;

    return {
      startLine: start,
      endLine: truncated ? start + SOURCE_MAX_LINES - 1 : end,
      truncated,
    };
  }

  /**
   * Resolves a repository-relative path and proves it stayed inside the root.
   *
   * The containment check runs twice on purpose. The first catches `..` and an
   * absolute path; the second catches a symlink, which survives normalisation
   * untouched and is the only remaining way out of the tree.
   */
  private async resolveWithinRepository(root: string, relativePath: string): Promise<string> {
    const candidate = path.resolve(root, relativePath);

    if (!contains(root, candidate)) throw this.outsideRepository(relativePath);

    let real: string;
    try {
      real = await realpath(candidate);
    } catch (error) {
      throw this.statError(relativePath, error);
    }

    if (!contains(root, real)) throw this.outsideRepository(relativePath);

    let stats;
    try {
      stats = await stat(real);
    } catch (error) {
      throw this.statError(relativePath, error);
    }

    if (!stats.isFile()) {
      throw new AppError(
        ERROR_CODES.SOURCE_FILE_NOT_FOUND,
        `${relativePath} is not a file`,
        { context: { file: relativePath } },
      );
    }

    if (stats.size > SOURCE_MAX_FILE_BYTES) {
      throw new AppError(
        ERROR_CODES.SOURCE_FILE_TOO_LARGE,
        `${relativePath} is larger than source retrieval will read`,
        { context: { file: relativePath, bytes: stats.size, limit: SOURCE_MAX_FILE_BYTES } },
      );
    }

    return real;
  }

  private async readFile(absolute: string, relativePath: string): Promise<string> {
    try {
      // UTF-8 explicitly: the graph's character offsets are counted in the same
      // encoding, so decoding differently would move every highlight.
      return await readFile(absolute, 'utf8');
    } catch (error) {
      throw this.statError(relativePath, error);
    }
  }

  private outsideRepository(relativePath: string): AppError {
    return new AppError(
      ERROR_CODES.SOURCE_PATH_NOT_ALLOWED,
      'That path is outside the project repository',
      { context: { file: relativePath } },
    );
  }

  private statError(relativePath: string, error: unknown): AppError {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'EACCES' || code === 'EPERM') {
      return new AppError(
        ERROR_CODES.SOURCE_NOT_READABLE,
        'Permission denied while reading that file',
        { context: { file: relativePath } },
      );
    }

    return new AppError(
      ERROR_CODES.SOURCE_FILE_NOT_FOUND,
      `${relativePath} was not found in the project repository`,
      { context: { file: relativePath } },
    );
  }
}

/**
 * Rejects everything that is not a repository-relative POSIX path.
 *
 * Done before any filesystem call so an obviously hostile path never reaches
 * `resolve`, and so the error says what was wrong rather than "not found".
 */
function normalizeRelative(requested: string): string {
  const trimmed = requested.trim();

  if (trimmed.includes('\u0000')) {
    throw new AppError(ERROR_CODES.SOURCE_PATH_NOT_ALLOWED, 'A path must not contain a NUL byte');
  }

  // Backslashes so a Windows-style path cannot smuggle a separator past the
  // segment check below.
  const posix = trimmed.replaceAll('\\', '/');

  if (posix.startsWith('/') || /^[a-zA-Z]:\//.test(posix)) {
    throw new AppError(
      ERROR_CODES.SOURCE_PATH_NOT_ALLOWED,
      'A source path must be relative to the repository root',
      { context: { file: requested } },
    );
  }

  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');

  if (segments.includes('..')) {
    throw new AppError(
      ERROR_CODES.SOURCE_PATH_NOT_ALLOWED,
      'A source path must not climb above the repository root',
      { context: { file: requested } },
    );
  }

  if (segments.length === 0) {
    throw new AppError(ERROR_CODES.SOURCE_PATH_NOT_ALLOWED, 'A source path is required');
  }

  return segments.join('/');
}

/**
 * The language a file extension names, for syntax highlighting in a viewer.
 *
 * Deliberately not `@ckg/language-detection`'s answer: that decides what to
 * *index*, which is a different and stricter question than what to colour.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.sql': 'sql',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.css': 'css',
  '.html': 'html',
  '.sh': 'shell',
};

function languageOf(relativePath: string): string | null {
  return LANGUAGE_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ?? null;
}
