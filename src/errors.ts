// Typed error hierarchy — callers branch on `instanceof` instead of parsing strings.
// Every non-2xx response maps to a discriminated subclass of AltaerError.

/** Base for every error this SDK raises on a non-2xx response. */
export class AltaerError extends Error {
  /** HTTP status code. Set to 0 for network errors that never got a
   *  response (DNS failure, socket reset, AbortController, etc.). */
  readonly statusCode: number;
  /** Machine-readable code from the server's error envelope when one is
   *  present. `null` when the response wasn't structured JSON or when
   *  the request never reached the server. */
  readonly code: string | null;
  /** The raw response body (parsed JSON when possible, otherwise the
   *  raw text). Useful when debugging unfamiliar errors. */
  readonly body: unknown;
  /** Structured context from the server error envelope (shape depends on `code`).
   *  Null when envelope had no `data`. */
  readonly data: Record<string, unknown> | null;
  /** Server-side request id when Altaer returned one. Include this
   *  when reporting an issue — it lets the platform team look up the
   *  exact request in their logs. */
  readonly requestId: string | null;

  constructor(
    message: string,
    statusCode: number,
    code: string | null,
    body: unknown,
    requestId: string | null
  ) {
    super(message);
    this.name = 'AltaerError';
    this.statusCode = statusCode;
    this.code = code;
    this.body = body;
    // Envelope nests data inside `error`; keep a top-level fallback for flat JSON.
    const envelope = body as
      | { error?: { data?: unknown } | string; data?: unknown }
      | null
      | undefined;
    const rawError = envelope?.error;
    const envelopeData =
      (typeof rawError === 'object' && rawError !== null ? rawError.data : undefined) ??
      envelope?.data;
    this.data =
      typeof envelopeData === 'object' && envelopeData !== null && !Array.isArray(envelopeData)
        ? (envelopeData as Record<string, unknown>)
        : null;
    this.requestId = requestId;
  }
}

/** 400 — body validation failure. Includes the server's machine-readable
 *  reason so callers can map to a localized message on their side. */
export class ValidationError extends AltaerError {
  constructor(message: string, code: string | null, body: unknown, requestId: string | null) {
    super(message, 400, code, body, requestId);
    this.name = 'ValidationError';
  }
}

/** 401 — missing or invalid `x-api-key`. Usually means the key was
 *  rotated. Rotate-and-retry should be safe for idempotent calls. */
export class AuthError extends AltaerError {
  constructor(message: string, code: string | null, body: unknown, requestId: string | null) {
    super(message, 401, code, body, requestId);
    this.name = 'AuthError';
  }
}

/** 404 — resource not found, or scoped to a different tenant. */
export class NotFoundError extends AltaerError {
  constructor(message: string, code: string | null, body: unknown, requestId: string | null) {
    super(message, 404, code, body, requestId);
    this.name = 'NotFoundError';
  }
}

/** 409 — conflict, typically order state mismatch (e.g. trying to
 *  cancel a `completed` order, or redispatching one not in
 *  `noDriverFound`). */
export class ConflictError extends AltaerError {
  constructor(message: string, code: string | null, body: unknown, requestId: string | null) {
    super(message, 409, code, body, requestId);
    this.name = 'ConflictError';
  }
}

/** 429 — your plan's rate limit was exceeded. `retryAfterSec` is parsed
 *  from the `Retry-After` header when the server provides it. */
export class RateLimitError extends AltaerError {
  readonly retryAfterSec: number | null;

  constructor(
    message: string,
    code: string | null,
    retryAfterSec: number | null,
    body: unknown,
    requestId: string | null
  ) {
    super(message, 429, code, body, requestId);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** 5xx — server-side error. The SDK retries these automatically (up to
 *  `maxRetries`); if you see this in your catch block, every retry
 *  failed. */
export class ServerError extends AltaerError {
  constructor(message: string, statusCode: number, body: unknown, requestId: string | null) {
    super(message, statusCode, null, body, requestId);
    this.name = 'ServerError';
  }
}

/** Network-layer failure — DNS, connection refused, socket reset,
 *  timeout, AbortController abort. Same retry treatment as 5xx (network
 *  blips are usually transient). `statusCode` is 0 because no response
 *  ever arrived. */
export class NetworkError extends AltaerError {
  constructor(message: string, cause?: unknown) {
    super(message, 0, 'network_error', null, null);
    this.name = 'NetworkError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Webhook signature verification failed. Either the signature header
 *  is malformed, the secret is wrong, the body was tampered with, or
 *  the timestamp is outside the tolerance window (replay protection). */
export class SignatureVerificationError extends Error {
  /** Sub-reason for the failure. Useful when triaging — `expired` and
   *   `bad_signature` mean different things operationally. */
  readonly reason: 'missing_header' | 'malformed_header' | 'expired' | 'bad_signature';

  constructor(message: string, reason: SignatureVerificationError['reason']) {
    super(message);
    this.name = 'SignatureVerificationError';
    this.reason = reason;
  }
}
