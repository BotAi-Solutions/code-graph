import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { CodeSearchMatch, Project } from '@ckg/shared';
import { CODE_SEARCH_MAX_LINE_TEXT, isAnalysableCategory, SOURCE_MAX_FILE_BYTES } from '@ckg/shared';
import { classifyFile, scanRepository } from '@ckg/language-detection';
import { contains, type SourceRoots } from '../source/source-root.js';

/**
 * Searching a project's source text.
 *
 * The graph answers questions about things the indexer *recorded*; this answers
 * questions about what the files actually say. A string in a comment, in a
 * template literal, in a YAML value, in a language nothing here can parse — none
 * of those is a graph node, and all of them are ordinary things to go looking
 * for.
 *
 * ## What it does, exactly
 *
 * Literal, case-sensitive substring matching. Not a regular expression, not a
 * glob, not a pattern of any kind: `user.service` matches the eleven characters
 * `user.service` and nothing else, and `(` is a parenthesis. Nothing is
 * interpreted, nothing is ranked, and the same query over the same tree always
 * produces the same page.
 *
 * ## What it does not do
 *
 * It never executes anything. There is no subprocess, no `grep`, no shell, and
 * therefore no argument or interpolation to get wrong — the query reaches
 * `String.prototype.indexOf` and goes no further.
 *
 * ## Which files
 *
 * The repository's own walk (`scanRepository`) supplies the file list, so the
 * ignore policy is the one the indexer uses rather than a second list that
 * would drift from it: `node_modules`, `dist`, `.git`, lock files and the rest
 * are already gone, and symlinks are already not followed.
 *
 * Of what survives that, the categories the pipeline treats as analysable are
 * searched — code, documents, configuration, schemas and SQL. `binary` is
 * excluded by construction rather than by an extension blacklist, and
 * `generated` and `vendor` are excluded because a match in a bundle or a
 * checked-in dependency answers nobody's question.
 */

export interface CodeSearchRequest {
  projectId: string;
  q: string;
  limit: number;
}

export interface CodeSearchResult {
  matches: CodeSearchMatch[];
  /**
   * Occurrences found across every file searched — not the size of `matches`.
   * Exact, unless `filesSkipped` or `scanTruncated` says otherwise.
   */
  total: number;
  limit: number;
  /** True when `total` exceeds `limit`, so `matches` is a page of the answer. */
  truncated: boolean;
  filesSearched: number;
  /** Files passed over for being larger than source retrieval will read. */
  filesSkipped: number;
  /** True when the walk stopped early, which makes `total` a floor. */
  scanTruncated: boolean;
}

export interface CodeSearchProjectResolver {
  getById(projectId: string): Promise<Project>;
}

export class CodeSearchService {
  constructor(
    private readonly roots: SourceRoots,
    private readonly projects: CodeSearchProjectResolver,
  ) {}

  async search(request: CodeSearchRequest): Promise<CodeSearchResult> {
    this.roots.assertEnabled();
    // Before anything touches a disk: an unknown project reads as
    // PROJECT_NOT_FOUND rather than as a missing repository, matching every
    // other project-scoped read in this API.
    await this.projects.getById(request.projectId);

    const root = await this.roots.resolve(request.projectId);
    const scan = await scanRepository(root);

    // `scanRepository` already sorts, so walking it in order gives the
    // file → line → column ordering the contract promises without a sort of
    // our own, and without holding every match to sort at the end.
    const searchable = scan.files.filter((file) =>
      isAnalysableCategory(classifyFile(file).category),
    );

    const matches: CodeSearchMatch[] = [];
    let total = 0;
    let filesSearched = 0;
    let filesSkipped = 0;

    for (const relative of searchable) {
      const absolute = path.resolve(root, relative);

      // The walk cannot produce a path outside the root — it never follows a
      // symlink and every name comes from a `readdir` beneath it. Asserted
      // anyway, because the cost of being wrong here is reading a file the
      // project's owner never offered.
      if (!contains(root, absolute)) continue;

      let size: number;
      try {
        size = (await stat(absolute)).size;
      } catch {
        // Deleted or unreadable since the walk. One file is not a reason to
        // fail a search over thousands.
        continue;
      }

      if (size > SOURCE_MAX_FILE_BYTES) {
        filesSkipped += 1;
        continue;
      }

      filesSearched += 1;
      total += await this.searchFile(absolute, relative, request, matches);
    }

    return {
      matches,
      total,
      limit: request.limit,
      truncated: total > matches.length,
      filesSearched,
      filesSkipped,
      scanTruncated: scan.truncated,
    };
  }

  /**
   * One file, a line at a time.
   *
   * Streamed rather than read whole so that a large file costs one line of
   * memory rather than its own size. Returns the occurrences counted, and
   * appends to `matches` only while there is room — which is what lets the
   * count stay exact while the response stays bounded.
   */
  private async searchFile(
    absolute: string,
    relativePath: string,
    request: CodeSearchRequest,
    matches: CodeSearchMatch[],
  ): Promise<number> {
    const reader = createInterface({
      input: createReadStream(absolute, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let found = 0;
    let line = 0;

    try {
      for await (const text of reader) {
        line += 1;

        // Non-overlapping, scanning forward: `aa` occurs once in `aaa`, which
        // is what every other literal search anyone has used does.
        let from = 0;
        for (;;) {
          const column = text.indexOf(request.q, from);
          if (column === -1) break;

          found += 1;
          if (matches.length < request.limit) {
            matches.push({
              filePath: relativePath,
              line,
              column,
              match: request.q,
              ...windowAround(text, column, request.q.length),
            });
          }

          from = column + request.q.length;
        }
      }
    } catch {
      // Unreadable part-way through — a device file, a permissions change, an
      // encoding the stream rejects. What was counted stands.
    } finally {
      reader.close();
    }

    return found;
  }
}

/**
 * The matching line, or a window of it centred on the match.
 *
 * A minified bundle is one line of two megabytes; returning it because a term
 * appeared in it would be worse than returning nothing, and returning its first
 * two hundred characters would usually not contain the match. So the window
 * follows the match, and says when it is a window.
 */
function windowAround(
  text: string,
  column: number,
  matchLength: number,
): { lineText: string; lineTruncated: boolean } {
  if (text.length <= CODE_SEARCH_MAX_LINE_TEXT) {
    return { lineText: text, lineTruncated: false };
  }

  // Centre on the match, then clamp to the line so the window is always the
  // full width even when the match sits at either end.
  const half = Math.floor((CODE_SEARCH_MAX_LINE_TEXT - matchLength) / 2);
  const start = Math.max(0, Math.min(column - Math.max(half, 0), text.length - CODE_SEARCH_MAX_LINE_TEXT));

  return {
    lineText: text.slice(start, start + CODE_SEARCH_MAX_LINE_TEXT),
    lineTruncated: true,
  };
}
