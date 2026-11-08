/**
 * Errors the media layer raises.
 *
 * The class carries an HTTP-ready code because the transport needs to turn it
 * into a status without parsing prose, but it does not import `node:http` or know
 * about a response: the media layer is deterministic product logic, and the
 * mapping lives at the edge.
 *
 * `retryable` distinguishes "try again" from "this will never work". A corrupt
 * image is not retryable; a deletion that raced an upload is. A client that
 * retried both would keep sending bytes the server has already rejected.
 */

export type MediaErrorCode =
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_UNSUPPORTED_FORMAT'
  | 'MEDIA_MIME_MISMATCH'
  | 'MEDIA_CORRUPT'
  | 'MEDIA_ANIMATED_UNSUPPORTED'
  | 'MEDIA_DIMENSIONS_EXCEEDED'
  | 'MEDIA_PIXELS_EXCEEDED'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_REFERENCED'
  | 'MEDIA_STATE_CONFLICT'
  | 'MEDIA_COUNT_EXCEEDED'
  | 'MEDIA_TOTAL_TOO_LARGE'
  | 'MEDIA_UNAVAILABLE'
  | 'MEDIA_DECODE_BUSY'
  | 'MEDIA_STORE_FAILED';

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MediaErrorCode,
    message: string,
    status: number,
    options: { readonly retryable?: boolean; readonly details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

/** Media errors are deliberately both structured and cheap to assert on. */
export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError;
}
