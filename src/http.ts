import { randomUUID } from 'crypto';
import {
  AltaerError,
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from './errors';

// Internal HTTP transport. Adds the three ergonomic touches over a
// raw fetch:
//
//   1. Auto Idempotency-Key  — every POST gets a UUID v4 unless caller
//                              passes their own; safe network retries
//                              return the cached response (24h TTL on
//                              the server).
//   2. Exponential backoff   — 5xx and network errors auto-retry with
//                              200ms / 400ms / 800ms … capped at 5s,
//                              up to `maxRetries`. With idempotency-key
//                              this is always safe.
//   3. Typed error mapping   — 400 → ValidationError, 401 → AuthError,
//                              404 → NotFoundError, etc. Callers branch
//                              on `instanceof` instead of parsing strings.
//
// No third-party deps — uses Node 18's built-in `fetch` and `crypto`.

export interface RequestOptions {
  /** Override the auto-generated Idempotency-Key. Useful when you're
   *  retrying at a higher level and want the SDK to honor the caller's
   *  key instead. */
  idempotencyKey?: string;
  /** Per-request override for the client-level retry count. */
  maxRetries?: number;
  /** Per-request AbortSignal. The SDK propagates it to the underlying
   *  fetch — callers can cancel from request-scoped controllers. */
  signal?: AbortSignal;
}

export interface HttpClientConfig {
  /** Tenant API key (your `x-api-key`). */
  apiKey: string;
  /** Base URL. Defaults to https://altaer.app. Override for staging
   *  (https://staging.altaer.app) or self-hosted environments. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Max retries for 5xx + network errors. Default 3. */
  maxRetries?: number;
  /** Optional custom fetch (useful in tests or runtimes without
   *  globalThis.fetch). Must conform to the standard fetch signature. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://altaer.app';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 5_000;

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  /** Resolved base URL (trailing slash stripped). Exposed so the
   *  tracking socket can connect to the same origin without re-parsing
   *  the user-supplied config. */
  get baseUrlForTracking(): string {
    return this.baseUrl;
  }

  constructor(config: HttpClientConfig) {
    if (!config.apiKey) {
      throw new Error('AltaerClient: `apiKey` is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        'AltaerClient: global fetch is not available. Pass a `fetch` implementation in the config (Node 18+ has it built in).'
      );
    }
  }

  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  async post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  async put<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, opts);
  }

  async delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts?: RequestOptions
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const maxRetries = opts?.maxRetries ?? this.maxRetries;

    // Idempotency-Key persists across retries — that's the whole point.
    // The server caches the first response (24h) and replays it on
    // subsequent attempts with the same key, so a retry storm can never
    // double-charge / double-create.
    const idempotencyKey = method === 'POST' ? (opts?.idempotencyKey ?? randomUUID()) : undefined;

    let attempt = 0;
    // No real ceiling on `for` — we exit via `return` on success or via
    // `throw` after retries exhausted.
    for (;;) {
      attempt += 1;
      try {
        const response = await this._send(method, url, body, {
          idempotencyKey,
          signal: opts?.signal,
        });
        if (response.ok) {
          return await this._parseSuccess<T>(response);
        }
        const error = await this._buildError(response);
        // Only retry on 5xx within the retry budget. 4xx errors are
        // caller's fault — retrying won't fix them.
        if (response.status >= 500 && response.status < 600 && attempt <= maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw error;
      } catch (err) {
        if (err instanceof AltaerError) throw err;
        // Network-layer failure (DNS, socket, timeout, abort). Retry if
        // we have budget left; the body never reached the server so
        // re-sending with the same idempotency-key is safe by definition.
        const networkErr = new NetworkError(err instanceof Error ? err.message : String(err), err);
        if (attempt <= maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw networkErr;
      }
    }
  }

  private async _send(
    method: string,
    url: string,
    body: unknown,
    extras: { idempotencyKey?: string; signal?: AbortSignal }
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'User-Agent': `altaer-sdk-node/${SDK_VERSION}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (extras.idempotencyKey) {
      headers['Idempotency-Key'] = extras.idempotencyKey;
    }

    // Compose a timeout AbortController with the caller's signal so
    // either can cancel.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const linkedSignal = extras.signal
      ? this._linkSignals(extras.signal, controller.signal)
      : controller.signal;

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: linkedSignal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private _linkSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (a.aborted) return a;
    if (b.aborted) return b;
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return ctrl.signal;
  }

  private async _parseSuccess<T>(response: Response): Promise<T> {
    // 204 No Content — treat as void. Callers typing the return as
    // `void` or `{}` get an empty object back so destructuring doesn't
    // throw at runtime.
    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ServerError(
        'Server returned non-JSON response',
        response.status,
        text,
        response.headers.get('x-request-id')
      );
    }
  }

  private async _buildError(response: Response): Promise<AltaerError> {
    const requestId = response.headers.get('x-request-id');
    let body: unknown = null;
    let code: string | null = null;
    let message = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        body = JSON.parse(text);
        if (typeof body === 'object' && body !== null) {
          const obj = body as { error?: string; code?: string; message?: string };
          message = obj.error ?? obj.message ?? message;
          code = obj.code ?? null;
        }
      }
    } catch {
      // Body wasn't JSON. Keep `body = null` and use the default message.
    }

    switch (response.status) {
      case 400:
        return new ValidationError(message, code, body, requestId);
      case 401:
        return new AuthError(message, body, requestId);
      case 404:
        return new NotFoundError(message, code, body, requestId);
      case 409:
        return new ConflictError(message, code, body, requestId);
      case 429: {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : null;
        return new RateLimitError(
          message,
          Number.isFinite(seconds) ? seconds : null,
          body,
          requestId
        );
      }
      default:
        if (response.status >= 500) {
          return new ServerError(message, response.status, body, requestId);
        }
        return new AltaerError(message, response.status, code, body, requestId);
    }
  }

  private async _backoff(attempt: number): Promise<void> {
    // Exponential with full jitter — same shape AWS recommends. The
    // jitter prevents synchronized retry storms across many clients.
    const exp = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const delay = Math.floor(Math.random() * exp);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// Stamped on the User-Agent header so the platform team can see in
// their logs which SDK version a partner is on. No automated sync —
// bump this by hand together with `package.json`'s version.
const SDK_VERSION = '0.0.24';
