import { ERROR_CODE_STATUS, ERROR_CODES, type ApiErrorDetail, type ErrorCode } from '@ckg/shared';

/**
 * The only error type the application throws on purpose.
 *
 * Services throw `AppError`; the Fastify error handler is the single place that
 * turns one into a response. Nothing ever throws a bare string, and no layer
 * below the handler formats an error body.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ApiErrorDetail[] | undefined;
  /** Additional context for the operator; never sent to the client. */
  readonly context: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: ApiErrorDetail[];
      context?: Record<string, unknown>;
      cause?: unknown;
      statusCode?: number;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode ?? ERROR_CODE_STATUS[code];
    this.details = options.details;
    this.context = options.context;
  }

  static notFound(code: ErrorCode, message: string): AppError {
    return new AppError(code, message);
  }

  static projectNotFound(projectId: string): AppError {
    return new AppError(ERROR_CODES.PROJECT_NOT_FOUND, `Project ${projectId} was not found`);
  }

  static repositoryNotFound(projectId: string): AppError {
    return new AppError(
      ERROR_CODES.REPOSITORY_NOT_FOUND,
      `Project ${projectId} has no repository configured`,
    );
  }

  static analysisNotFound(analysisId: string): AppError {
    return new AppError(ERROR_CODES.ANALYSIS_NOT_FOUND, `Analysis ${analysisId} was not found`);
  }

  static nodeNotFound(nodeId: string): AppError {
    return new AppError(ERROR_CODES.NODE_NOT_FOUND, `Graph node ${nodeId} was not found`);
  }

  static validation(message: string, details: ApiErrorDetail[]): AppError {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, message, { details });
  }

  static internal(message: string, cause?: unknown): AppError {
    return new AppError(ERROR_CODES.INTERNAL_ERROR, message, { cause });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
