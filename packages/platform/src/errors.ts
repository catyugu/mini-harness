export type ErrorCode = 'invalid_input' | 'unauthorized' | 'forbidden' | 'not_found'
  | 'conflict' | 'payload_too_large' | 'unavailable';

/** An operational failure with a message suitable for the requesting client. */
export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
