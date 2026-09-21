import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { codeSearchMatchSchema, codeSearchQuerySchema, projectIdParamSchema } from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { CodeSearchService } from './code-search.service.js';

/**
 * Searching the text of a project's source.
 *
 * Scoped to a project rather than to the filesystem, like source retrieval: the
 * repository root comes from the project's own record, so "find this string in
 * this project" is possible without offering "grep this machine".
 */
export function codeSearchRoutes(service: CodeSearchService): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/code/search',
      {
        schema: {
          tags: ['code-search'],
          summary: 'Find literal occurrences of a string in the project source',
          description:
            'Literal, case-sensitive substring search over the project’s source files — not a regular expression, not a glob, and nothing is interpreted or ranked. `UserRepository` does not match `userRepository`. One result per occurrence, so a line containing a term three times is three results; `meta.total` counts occurrences across every file searched, not the page. Results are ordered by file path, then line, then column. Files come from the same walk the indexer uses, so ignored directories, lock files, binaries, generated and vendored code are already excluded. Nothing is executed: the query reaches a string comparison and goes no further.',
          params: projectIdParamSchema,
          querystring: codeSearchQuerySchema,
          response: {
            200: envelopeSchema(z.array(codeSearchMatchSchema)),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const result = await service.search({
          projectId: request.params.projectId,
          q: request.query.q,
          limit: request.query.limit,
        });

        return reply.send(
          success(result.matches, {
            total: result.total,
            limit: result.limit,
            truncated: result.truncated,
            query: request.query.q,
            // What the count is a statement about. `total` is exact over the
            // files searched; these two are how a caller knows when that was
            // not the whole repository.
            filesSearched: result.filesSearched,
            filesSkipped: result.filesSkipped,
            scanTruncated: result.scanTruncated,
          }),
        );
      },
    );
  };
}
