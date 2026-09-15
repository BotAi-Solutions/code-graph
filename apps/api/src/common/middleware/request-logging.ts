import { LogController } from 'fastify';
import type { FastifyRequest } from 'fastify';

/**
 * Request logging policy.
 *
 * Fastify already emits a structured line per request on the logger it was
 * given, which inherits the platform's `module`/`service` fields — so the job
 * here is only to decide what *not* to log. Health checks are excluded because
 * an orchestrator polls them every few seconds and would otherwise drown out
 * everything worth reading.
 *
 * Request bodies are never logged: they carry repository paths today and will
 * carry credentials once git sources are authenticated.
 */
export function createLogController(): LogController {
  return new LogController({
    disableRequestLogging: (request: FastifyRequest) => request.url.startsWith('/health'),
    requestIdLogLabel: 'requestId',
  });
}
