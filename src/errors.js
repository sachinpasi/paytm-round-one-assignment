export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// counted under reservations_declined_total{reason}
export const DECLINE_CODES = new Set([
  'seat_taken',
  'per_user_limit',
  'idempotency_key_reuse',
  'seat_not_found',
  'show_not_found',
  'overloaded',
]);
