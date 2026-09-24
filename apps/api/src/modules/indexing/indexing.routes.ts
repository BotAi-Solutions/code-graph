import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  indexFreshnessSchema,
  indexProjectBodySchema,
  indexProjectResultSchema,
  projectIdParamSchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { FreshnessService } from './freshness.service.js';
import type { IndexingService } from './indexing.service.js';

export function indexingRoutes(
  indexing: IndexingService,
  freshness: FreshnessService,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/projects/index',
      {
        schema: {
          tags: ['analysis'],
          summary: 'Register a local directory if needed, and index it unless its graph is current',
          description:
            'The one-call form of the intake flow, for callers holding a directory rather than a project id. ' +
            'Finds the project registered at exactly that directory or creates one, then queues a run through the same path as POST /projects/:projectId/analysis — ' +
            'unless a run is already active (returned instead; never duplicated) or the stored graph already matches the files (nothing queued, unless `force`). ' +
            '202 when a run was queued, 200 otherwise. The path must be an absolute, readable local directory.',
          body: indexProjectBodySchema,
          response: {
            200: envelopeSchema(indexProjectResultSchema),
            202: envelopeSchema(indexProjectResultSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const result = await indexing.index({ path: request.body.path, force: request.body.force });
        return reply.status(result.jobCreated ? 202 : 200).send(success(result));
      },
    );

    app.get(
      '/projects/:projectId/freshness',
      {
        schema: {
          tags: ['analysis'],
          summary: 'Whether the stored graph still matches the files it was built from',
          description:
            'Compares the latest completed run with the working tree now: by content against the indexed commit for a git repository, by modification time otherwise. ' +
            '`unknown` carries its reason — a git-URL source, a run recorded before revisions were captured, or local filesystem access switched off.',
          params: projectIdParamSchema,
          response: { 200: envelopeSchema(indexFreshnessSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const report = await freshness.check(request.params.projectId);
        return reply.send(success(report));
      },
    );
  };
}
