import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SOURCE_MAX_LINES, sourceSchema, type SourceWindow } from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';

/**
 * `get_source` — read the code a location points at.
 *
 * The end of every other tool's sentence. `search_code` gives a file and a
 * line, `get_node` gives a file and a range, `trace_path` gives a chain of
 * both — and each of them stops at a coordinate. This is what turns a
 * coordinate into something a model can actually read.
 *
 * It calls `GET /api/projects/:projectId/source`, which is the one place in
 * this system that opens a file. Nothing here resolves a path, walks a
 * directory, follows a symlink or reads a byte: the containment rules, the
 * symlink re-check, the git refusal and the local-filesystem switch all live
 * behind that endpoint, and this tool cannot weaken them because it never
 * touches what they protect.
 */

const TOOL_NAME = 'get_source';

const lineSchema = {
  line: z.number().int().describe('1-based, as an editor counts.'),
  text: z.string(),
};

const outputSchema = {
  projectId: z.string().describe('The project read from, and the only one this file belongs to.'),
  file: z.string().describe('Repository-relative path, as the API echoes it back.'),
  language: z.string().nullable().describe('Inferred from the extension. Null when nothing is known.'),
  startLine: z.number().int().describe('First line returned, 1-based.'),
  endLine: z.number().int().describe('Last line returned, inclusive.'),
  totalLines: z.number().int().describe('Lines in the whole file, so a caller knows what it did not read.'),
  truncated: z
    .boolean()
    .describe(`True when the requested range was wider than one response may carry (${String(SOURCE_MAX_LINES)} lines).`),
  lines: z.array(z.object(lineSchema)),
};

/**
 * The structured payload, typed by the schema the SDK validates it against.
 *
 * Derived rather than written out a second time: a hand-kept interface that
 * drifted from the schema would compile and then fail on every call.
 */
type SourceOutput = z.infer<typeof sourceOutputObject>;

const sourceOutputObject = z.object(outputSchema);

export function registerGetSource(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Read source from a project',
      description:
        'Read a window of one file from an indexed project — the code behind a location another tool reported. ' +
        'Follows search_code (which gives a file and a line), get_node (a file and a range) or trace_path. ' +
        `Pass startLine and endLine: with neither, the whole file comes back, up to ${String(SOURCE_MAX_LINES)} lines. ` +
        'The path is repository-relative; absolute paths and `..` are refused. Requires a projectId from resolve_project, and reads only that project.',
      inputSchema: {
        projectId: z.uuid().describe('The project to read from, from resolve_project. Required; there is no default.'),
        file: z
          .string()
          .trim()
          .min(1)
          .max(1024)
          .describe('Repository-relative path, exactly as search_code, get_node or trace_path reported it.'),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line to read, 1-based and inclusive. Defaults to the start of the file.'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Last line to read, inclusive. Defaults to the end of the file.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, file, startLine, endLine }): Promise<CallToolResult> => {
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        // The API refuses this too; catching it here costs a round trip and
        // says which way round the arguments go.
        return {
          content: [
            {
              type: 'text',
              text: `endLine (${String(endLine)}) is before startLine (${String(startLine)}). Give the range in ascending order.`,
            },
          ],
          isError: true,
        };
      }

      let raw: unknown;
      try {
        raw = await api.get<unknown>(`/api/projects/${encodeURIComponent(projectId)}/source`, {
          // Forwarded as given: the path is the API's to validate, and a range
          // this layer adjusted would be a window the caller did not ask for.
          file,
          ...(startLine === undefined ? {} : { startLine: String(startLine) }),
          ...(endLine === undefined ? {} : { endLine: String(endLine) }),
        });
      } catch (error) {
        return failure(error, projectId, file);
      }

      // Checked against the API's own schema rather than trusted. A malformed
      // window would otherwise reach a model as source code, which is the one
      // kind of wrong answer here that would be acted on without question.
      const parsed = sourceSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text: `The graph API returned something that is not a source window for ${file}. Nothing is reported rather than guessing at malformed content.`,
            },
          ],
          isError: true,
        };
      }

      const window: SourceWindow = parsed.data;

      const output: SourceOutput = {
        projectId,
        file: window.file,
        language: window.language,
        startLine: window.startLine,
        endLine: window.endLine,
        totalLines: window.totalLines,
        truncated: window.truncated,
        lines: window.lines.map((entry) => ({ line: entry.line, text: entry.text })),
      };

      return { content: [{ type: 'text', text: render(output) }], structuredContent: output };
    },
  );
}

/**
 * The answer as prose: a header saying what this is, then the code with its
 * line numbers.
 *
 * The gutter is the point. A model that has just read lines 38 to 58 needs to
 * be able to say "line 44" and mean the same line the file does, and a bare
 * block of code makes that a counting exercise it will get wrong.
 */
function render(output: SourceOutput): string {
  const lines: string[] = [];

  const range =
    output.lines.length === 0
      ? 'no lines'
      : `lines ${String(output.startLine)}-${String(output.endLine)} of ${String(output.totalLines)}`;

  lines.push(`${output.file}  (${range}${output.language ? `, ${output.language}` : ''})`);

  if (output.truncated) {
    lines.push(
      `The requested range was wider than one response carries, so it was cut at ${String(SOURCE_MAX_LINES)} lines. Ask for a narrower range to see the rest.`,
    );
  }

  lines.push('');

  if (output.lines.length === 0) {
    lines.push('(the file is empty)');
    return lines.join('\n');
  }

  // Right-aligned to the widest number, so the code stays aligned with itself.
  const width = String(output.endLine).length;
  for (const entry of output.lines) {
    lines.push(`${String(entry.line).padStart(width, ' ')} | ${entry.text}`);
  }

  return lines.join('\n');
}

/**
 * A failed read, reported as a tool result rather than thrown.
 *
 * The API's codes are preserved because they mean different things a caller
 * acts on differently: a refused path is a mistake in the request, an
 * unreadable source is a property of the project, and neither is "the file is
 * empty".
 */
function failure(error: unknown, projectId: string, file: string): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`;
  } else if (error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND') {
    text = `There is no project with id "${projectId}". Call resolve_project to obtain a current project id — this one may have been deleted.`;
  } else if (error instanceof ApiError && error.code === 'SOURCE_PATH_NOT_ALLOWED') {
    text = `"${file}" is not a path this project will serve: ${error.message}. Paths are relative to the repository root — use one exactly as search_code, get_node or trace_path reported it.`;
  } else if (error instanceof ApiError && error.code === 'SOURCE_FILE_NOT_FOUND') {
    text = `"${file}" was not found in project ${projectId}. It may have been moved or deleted since the project was indexed; search_code will show where the file is now.`;
  } else if (error instanceof ApiError && error.code === 'SOURCE_NOT_READABLE') {
    text = `The source of project ${projectId} cannot be read: ${error.message}. A repository indexed from a git URL keeps no source on disk, so no file from it can be shown.`;
  } else if (error instanceof ApiError && error.code === 'SOURCE_FILE_TOO_LARGE') {
    text = `"${file}" is larger than source retrieval will read, so none of it can be shown.`;
  } else if (error instanceof ApiError) {
    text = `The graph API refused the read (${error.code}): ${error.message}`;
  } else {
    text = `Could not read that file: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
