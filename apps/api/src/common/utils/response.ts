import { z } from 'zod';
import type {
  ApiErrorBody,
  ApiErrorResponse,
  ApiMeta,
  ApiSuccessResponse,
} from '@ckg/shared';

/**
 * Every response leaves the API in the same envelope:
 *
 *   { success, data, error, meta }
 *
 * `success` responses carry `error: null`, failures carry `data: null`. These
 * helpers are the only way a body is constructed, so the shape cannot drift
 * between modules.
 */

export function success<TData>(data: TData, meta: ApiMeta = {}): ApiSuccessResponse<TData> {
  return { success: true, data, error: null, meta };
}

export function failure(error: ApiErrorBody, meta: ApiMeta = {}): ApiErrorResponse {
  return { success: false, data: null, error, meta };
}

const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

/** Response schema for OpenAPI: the envelope around a payload schema. */
export function envelopeSchema<TSchema extends z.ZodType>(data: TSchema) {
  return z.object({
    success: z.literal(true),
    data,
    error: z.null(),
    meta: z.record(z.string(), z.unknown()),
  });
}

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  data: z.null(),
  error: apiErrorSchema,
  meta: z.record(z.string(), z.unknown()),
});

/** Attached to every route so the documented failure shape is consistent. */
export const commonErrorResponses = {
  400: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  422: errorEnvelopeSchema,
  500: errorEnvelopeSchema,
  501: errorEnvelopeSchema,
} as const;
