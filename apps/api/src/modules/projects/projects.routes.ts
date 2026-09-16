import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createProjectBodySchema,
  listProjectsQuerySchema,
  projectIdParamSchema,
  projectSchema,
  projectSummarySchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { ProjectService } from './projects.service.js';

/**
 * Routes are intentionally thin: validate, delegate, wrap. No business rule and
 * no database query lives in this file, which is what keeps the domain free of
 * Fastify.
 */
export function projectRoutes(service: ProjectService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'Create a project',
          body: createProjectBodySchema,
          response: { 201: envelopeSchema(projectSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const project = await service.create(request.body);
        return reply.status(201).send(success(project));
      },
    );

    app.get(
      '/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'List projects with their graph size and last analysis',
          description:
            'The dashboard listing. Each row carries its repository, most recent run and node/edge counts, assembled in one query.',
          querystring: listProjectsQuerySchema,
          response: {
            200: envelopeSchema(z.array(projectSummarySchema)),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const { limit, offset } = request.query;
        const result = await service.list({ limit, offset });
        return reply.send(success(result.items, { total: result.total, limit, offset }));
      },
    );

    app.delete(
      '/projects/:projectId',
      {
        schema: {
          tags: ['projects'],
          summary: 'Delete a project and its graph',
          description:
            'Removes the project, its repository record, every analysis run and the whole stored graph. The analysed source on disk is never touched. Irreversible.',
          params: projectIdParamSchema,
          // 200 with an empty envelope rather than 204. Every other response
          // this API gives is `{ success, data, error, meta }`, and the web
          // client parses that shape unconditionally — a bodiless 204 would be
          // the one route it could not read.
          response: { 200: envelopeSchema(z.null()), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        await service.delete(request.params.projectId);
        return reply.send(success(null));
      },
    );

    app.get(
      '/projects/:projectId',
      {
        schema: {
          tags: ['projects'],
          summary: 'Fetch a single project',
          params: projectIdParamSchema,
          response: { 200: envelopeSchema(projectSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const project = await service.getById(request.params.projectId);
        return reply.send(success(project));
      },
    );
  };
}
