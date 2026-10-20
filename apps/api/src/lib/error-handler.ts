import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from './errors';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  instance: string;
  request_id: string;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
  [extra: string]: unknown;
}

export function buildProblem(
  request: Pick<FastifyRequest, 'url' | 'id'>,
  status: number,
  code: string,
  title: string,
  extra: Record<string, unknown> = {},
): ProblemBody {
  return {
    ...extra,
    type: `urn:barakah:error:${code}`,
    title,
    status,
    code,
    // Path only: query strings can carry values we must not echo or log.
    instance: request.url.split('?')[0] ?? '/',
    request_id: String(request.id),
  };
}

function clientErrorCode(status: number): string {
  switch (status) {
    case 400:
      return 'request.invalid';
    case 401:
      return 'auth.unauthorized';
    case 403:
      return 'auth.forbidden';
    case 404:
      return 'not_found';
    case 413:
      return 'request.too_large';
    case 415:
      return 'request.unsupported_media_type';
    case 429:
      return 'rate_limit.exceeded';
    default:
      return 'request.invalid';
  }
}

/**
 * RFC 7807 problem+json error handler.
 *  - AppError: its own status and stable code.
 *  - Validation errors: 400 `validation.error` with a field list.
 *  - Other 4xx: the framework's client-safe message.
 *  - 5xx: a generic message. Internal error text can contain SQL, paths or values, so it is only
 *    logged, never returned; the client gets a request_id to quote to the cashier.
 */
export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  let problem: ProblemBody;

  if (error instanceof AppError) {
    problem = buildProblem(request, error.status, error.code, error.message, error.extra);
  } else if (hasZodFastifySchemaValidationErrors(error)) {
    problem = buildProblem(request, 400, 'validation.error', 'Request validation failed', {
      errors: error.validation.map((v) => ({
        path: v.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)',
        message: v.message ?? 'invalid',
      })),
    });
  } else if (isResponseSerializationError(error)) {
    request.log.error({ err: error }, 'Response failed schema validation');
    problem = buildProblem(request, 500, 'internal.error', 'Internal Server Error');
  } else {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      problem = buildProblem(request, 500, 'internal.error', 'Internal Server Error');
    } else {
      problem = buildProblem(
        request,
        status,
        clientErrorCode(status),
        error.message || 'Bad Request',
      );
    }
  }

  void reply
    .status(problem.status)
    .header('content-type', 'application/problem+json')
    .send(problem);
}
