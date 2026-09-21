import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createProjectBodySchema,
  listProjectsQuerySchema,
  projectIdParamSchema,
  projectResolutionSchema,
  projectSchema,
  projectSummarySchema,
  resolveProjectQuerySchema,
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

    // Registered before the `:projectId` route it shares a prefix with. Fastify
    // prefers a static segment over a parametric one regardless of order, so
    // this is for the reader rather than the router — `resolve` is not a
    // project id and should not look like one in this file either.
    app.get(
      '/projects/resolve',
      {
        schema: {
          tags: ['projects'],
          summary: 'Find the indexed projects whose repository contains a path',
          description:
            'Turns a directory into the projects indexed from it — the way in for anything that holds a working directory rather than a project id. ' +
            'Matches are ordered most specific first: in a monorepo both an inner package and the repository root may be indexed, and each match carries its graph size and last run so the caller can tell a usable project from an empty one. ' +
            'An empty `matches` means nothing indexed covers that path, which is a successful answer and not a 404. ' +
            'A relative path is resolved the same way a stored relative `sourcePath` is. The path is never read, and need not exist.',
          querystring: resolveProjectQuerySchema,
          response: { 200: envelopeSchema(projectResolutionSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const resolution = await service.resolveByPath({ path: request.query.path });
        return reply.send(
          success(resolution, { total: resolution.matches.length, path: resolution.path }),
        );
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
