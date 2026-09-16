import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { projectIdParamSchema, sourceQuerySchema, sourceSchema } from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { SourceService } from './source.service.js';

/**
 * Reading source for an indexed project.
 *
 * One route, one verb, no writes. It is scoped to a project rather than to the
 * filesystem — the repository root comes from the project's own repository
 * record — which is what makes "read the file the graph pointed at" possible
 * without offering "read any file on this machine".
 */
export function sourceRoutes(service: SourceService): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/source',
      {
        schema: {
          tags: ['source'],
          summary: 'Read a window of one file from the project repository',
          description:
            'Addressed by a repository-relative `file`, by a graph `nodeId`, or by both. A node supplies its own indexed range, padded by `context` lines; an explicit `startLine`/`endLine` is honoured as given. Paths are resolved against the project’s registered repository root and re-checked after symlinks are followed, so `../` and a link out of the tree are both 403. Read-only, and the response never carries an absolute path.',
          params: projectIdParamSchema,
          querystring: sourceQuerySchema,
          response: { 200: envelopeSchema(sourceSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const window = await service.read({
          projectId: request.params.projectId,
          file: request.query.file,
          nodeId: request.query.nodeId,
          startLine: request.query.startLine,
          endLine: request.query.endLine,
          context: request.query.context,
        });

        return reply.send(
          success(window, {
            file: window.file,
            startLine: window.startLine,
            endLine: window.endLine,
            totalLines: window.totalLines,
            truncated: window.truncated,
          }),
        );
      },
    );
  };
}
