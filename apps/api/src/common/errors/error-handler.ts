import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ERROR_CODES, type ApiErrorDetail, type ErrorCode } from '@ckg/shared';
import { failure } from '../utils/response.js';
import { AppError, isAppError } from './app-error.js';

/**
 * The single exit point for every failure in the API.
 *
 * Whatever is thrown — an `AppError`, a schema validation failure, a database
 * driver error, a programming mistake — leaves through here as the standard
 * error envelope. Unexpected errors are logged in full and reported as a
 * generic 500, so internals never reach a client.
 */

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const meta = { requestId: request.id };

    if (hasZodFastifySchemaValidationErrors(error)) {
      // `instancePath` is the offending field as a JSON pointer ("/name");
      // the envelope reports it as a dotted path the client can read.
      const details: ApiErrorDetail[] = error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || '(root)',
        message: issue.message ?? 'invalid value',
      }));

      request.log.info({ details }, 'request validation failed');

      return reply.status(400).send(
        failure(
          {
            code: ERROR_CODES.VALIDATION_ERROR,
            message: 'Request validation failed',
            details,
          },
          meta,
        ),
      );
    }

    if (isAppError(error)) {
      const log = error.statusCode >= 500 ? request.log.error : request.log.info;
      log.call(
        request.log,
        { code: error.code, context: error.context, err: error.statusCode >= 500 ? error : undefined },
        error.message,
      );

      return reply.status(error.statusCode).send(
        failure(
          {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
          meta,
        ),
      );
    }

    // Fastify's own errors (bad JSON body, unsupported media type, ...).
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      request.log.info({ err: error }, 'request rejected');
      return reply.status(error.statusCode).send(
        failure({ code: ERROR_CODES.BAD_REQUEST, message: error.message }, meta),
      );
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(
      failure(
        { code: ERROR_CODES.INTERNAL_ERROR, message: 'An unexpected error occurred' },
        meta,
      ),
    );
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send(
      failure(
        {
          code: ERROR_CODES.NOT_FOUND,
          message: `Route ${request.method} ${request.url} does not exist`,
        },
        { requestId: request.id },
      ),
    );
  });
}

/**
 * Wraps a driver-level failure so callers never see `pg` internals. Used at the
 * boundary of service methods that talk to the database.
 */
export function asDatabaseError(error: unknown, operation: string): AppError {
  if (isAppError(error)) return error;
  return new AppError(ERROR_CODES.DATABASE_ERROR as ErrorCode, `Database operation failed`, {
    cause: error,
    context: { operation },
  });
}
