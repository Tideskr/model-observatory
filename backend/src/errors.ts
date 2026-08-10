import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const known = error instanceof AppError
  const validation = 'validation' in error && error.validation != null
  const status = known ? error.statusCode : validation ? 400 : 500
  const code = known ? error.code : validation ? 'request_validation_failed' : 'internal_error'

  if (status >= 500) {
    request.log.error({ err: error }, 'request failed')
  } else {
    request.log.info({ code, status }, 'request rejected')
  }

  void reply
    .status(status)
    .type('application/problem+json')
    .send({
      type: `urn:model-observatory:problem:${code}`,
      title: status >= 500 ? 'Internal Server Error' : 'Request Rejected',
      status,
      detail: known ? error.message : validation ? 'The request does not match the API schema.' : 'The request could not be completed.',
      code,
      request_id: request.id,
    })
}
