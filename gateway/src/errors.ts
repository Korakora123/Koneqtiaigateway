/** Error with an HTTP status and a stable machine-readable code (OpenAI-style error body). */
export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toBody(): { error: { type: string; code: string; message: string } } {
    return { error: { type: errorType(this.status), code: this.code, message: this.message } };
  }
}

function errorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 503) return 'busy';
  if (status === 501) return 'not_implemented';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export const busy = (retryAfterSec: number, why: string): GatewayError =>
  new GatewayError(503, 'busy', why, Math.max(1, Math.ceil(retryAfterSec)));
