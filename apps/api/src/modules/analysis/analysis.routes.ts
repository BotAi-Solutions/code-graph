import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  analysisJobSchema,
  analysisParamsSchema,
  createAnalysisBodySchema,
  projectIdParamSchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { AnalysisService } from './analysis.service.js';

export function analysisRoutes(service: AnalysisService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/projects/:projectId/analysis',
      {
        schema: {
          tags: ['analysis'],
          summary: 'Queue an analysis run for the project repository',
          description:
            'Returns immediately with a QUEUED job. The worker runs SCIP, builds the graph and persists it; poll the job for progress.',
          params: projectIdParamSchema,
          body: createAnalysisBodySchema,
          response: { 202: envelopeSchema(analysisJobSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const job = await service.enqueue({
          projectId: request.params.projectId,
          language: request.body?.language,
        });
        return reply.status(202).send(success(job));
      },
    );

    app.get(
      '/projects/:projectId/analysis',
      {
        schema: {
          tags: ['analysis'],
          summary: 'List analysis runs for a project, newest first',
          params: projectIdParamSchema,
          response: { 200: envelopeSchema(z.array(analysisJobSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const jobs = await service.listForProject(request.params.projectId);
        return reply.send(success(jobs, { total: jobs.length }));
      },
    );

    app.get(
      '/projects/:projectId/analysis/:analysisId',
      {
        schema: {
          tags: ['analysis'],
          summary: 'Fetch a single analysis run',
          params: analysisParamsSchema,
          response: { 200: envelopeSchema(analysisJobSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const job = await service.getById(request.params.projectId, request.params.analysisId);
        return reply.send(success(job));
      },
    );
  };
}
