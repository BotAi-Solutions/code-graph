import type { ErrorCode } from '../constants/error-codes.js';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  /** Field-level validation issues; omitted for non-validation failures. */
  details?: ApiErrorDetail[];
}

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export type ApiMeta = Record<string, unknown>;

export interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
  error: null;
  meta: ApiMeta;
}

export interface ApiErrorResponse {
  success: false;
  data: null;
  error: ApiErrorBody;
  meta: ApiMeta;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export interface PaginationMeta extends ApiMeta {
  total: number;
  limit: number;
  offset: number;
}
