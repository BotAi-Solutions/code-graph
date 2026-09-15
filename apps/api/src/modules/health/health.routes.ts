import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { envelopeSchema, success } from '../../common/utils/response.js';
import type { HealthService } from './health.service.js';

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number().int(),
  checks: z.object({ database: z.enum(['ok', 'unavailable']) }),
});

export function healthRoutes(service: HealthService): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/health',
      {
        schema: {
          tags: ['health'],
          summary: 'Liveness and dependency check',
          response: { 200: envelopeSchema(healthSchema), 503: envelopeSchema(healthSchema) },
        },
      },
      async (_request, reply) => {
        const report = await service.check();
        return reply.status(report.status === 'ok' ? 200 : 503).send(success(report));
      },
    );
  };
}
