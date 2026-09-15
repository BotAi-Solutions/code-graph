import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createRepositoryBodySchema,
  projectIdParamSchema,
  repositorySchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { RepositoryService } from './repositories.service.js';

export function repositoryRoutes(service: RepositoryService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/projects/:projectId/repository',
      {
        schema: {
          tags: ['repositories'],
          summary: 'Attach or replace the source repository for a project',
          params: projectIdParamSchema,
          body: createRepositoryBodySchema,
          response: { 201: envelopeSchema(repositorySchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const repository = await service.attach({
          projectId: request.params.projectId,
          sourceType: request.body.sourceType,
          sourcePath: request.body.sourcePath,
          commitHash: request.body.commitHash ?? null,
        });
        return reply.status(201).send(success(repository));
      },
    );

    app.get(
      '/projects/:projectId/repository',
      {
        schema: {
          tags: ['repositories'],
          summary: 'Fetch the source repository configured for a project',
          params: projectIdParamSchema,
          response: { 200: envelopeSchema(repositorySchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const repository = await service.getForProject(request.params.projectId);
        return reply.send(success(repository));
      },
    );
  };
}
