import { createHmac, timingSafeEqual } from 'crypto';
import { SignatureVerificationError } from './errors';
import type { WebhookEvent } from './types';

// HMAC-SHA-256 over `${timestamp}.${rawBody}`; header X-Altaer-Signature: t=<unix>,v1=<hex>.
// Two checks: constant-time HMAC match + timestamp within toleranceSec (default 5 min, replay guard).
// Throws SignatureVerificationError(.reason: missing_header|malformed_header|expired|bad_signature).

const SIGNATURE_HEADER = 'x-altaer-signature';
const DEFAULT_TOLERANCE_SEC = 5 * 60;

export interface VerifyWebhookInput {
  /** Raw request body bytes exactly as received. Do NOT parse JSON first — re-stringifying
   *  can reorder keys and invalidate the signature. Use express.raw({ type:'application/json' }). */
  body: string | Buffer;
  /** Value of the `X-Altaer-Signature` request header. */
  signature: string | string[] | null | undefined;
  /** Your webhook secret (`whsec_...`). Rotate from the hub's /developers page;
   *  verify the new secret works before retiring the old one. */
  secret: string;
  /** Max age of the signed timestamp, in seconds. Older signatures are
   *  rejected to prevent replay. Default 300 (5 minutes). */
  toleranceSec?: number;
}

/** Verify a webhook signature and return the typed event. Throws
 *  SignatureVerificationError on any failure (missing/malformed header,
 *  expired timestamp, signature mismatch). Pass `body` as raw bytes — do
 *  NOT parse JSON first. Narrow the result on `event.type`. */
export const verifyWebhook = (input: VerifyWebhookInput): WebhookEvent => {
  const header = coerceHeader(input.signature);
  if (!header) {
    throw new SignatureVerificationError('Missing X-Altaer-Signature header', 'missing_header');
  }

  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    throw new SignatureVerificationError(
      `Malformed X-Altaer-Signature header (expected "t=<unix>,v1=<hex>", got "${header}")`,
      'malformed_header'
    );
  }

  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) {
    throw new SignatureVerificationError(
      `Signature timestamp is outside the tolerance window of ${tolerance}s (signed at ${parsed.timestamp}, now ${nowSec})`,
      'expired'
    );
  }

  const bodyString = Buffer.isBuffer(input.body) ? input.body.toString('utf8') : input.body;
  const expected = createHmac('sha256', input.secret)
    .update(`${parsed.timestamp}.${bodyString}`)
    .digest('hex');

  if (!safeHexEqual(expected, parsed.v1)) {
    throw new SignatureVerificationError(
      'Signature mismatch — body may have been tampered with, or the wrong secret is configured',
      'bad_signature'
    );
  }

  // Signature is valid → safe to parse the body as a typed event.
  // Cast is safe because the server is the only source of these
  // payloads and the envelope shape is contractual.
  return JSON.parse(bodyString) as WebhookEvent;
};

/** Express middleware: raw-body parser + signature verify + your handler.
 *  Failure model (Altaer retries non-2xx up to 12×): bad-sig→400; handler throws→200 (stops retries);
 *  handler hangs→5s timeout→retry; handler returns→200. */
export const altaerWebhookRoute = (
  config: {
    secret: string;
    toleranceSec?: number;
    /** Skip the default `express.raw` body parser. Useful if you've
     *  already mounted raw-body middleware globally and don't want to
     *  layer another one. */
    skipRawParser?: boolean;
  },
  handler: (event: WebhookEvent) => void | Promise<void>
): MiddlewareFn[] => {
  const middlewares: MiddlewareFn[] = [];
  if (!config.skipRawParser) {
    middlewares.push(rawBodyMiddleware());
  }
  // 3-arg arity keeps Express from treating this as an error middleware (4-arg form).
  middlewares.push(async (req, res, _next) => {
    let event: WebhookEvent | null = null;
    try {
      event = verifyWebhook({
        body: req.body,
        signature: req.headers[SIGNATURE_HEADER] as string | string[] | undefined,
        secret: config.secret,
        toleranceSec: config.toleranceSec,
      });
      await handler(event);
      res.sendStatus(200);
    } catch (err) {
      if (err instanceof SignatureVerificationError) {
        // 400 — don't leak details in the body; reason is in the SDK error for logging.
        res.status(400).send('Invalid signature');
        return;
      }
      // Handler bug. Log loudly on the tenant's side and 200 back so
      // Altaer stops trying — retries won't fix a code path that always throws.
      // event is non-null here: verifyWebhook only throws SignatureVerificationError.
      console.error(
        '[altaer-sdk] webhook handler threw — responded 200 to avoid Altaer retries. ' +
          'Event id: ' +
          event!.id +
          ', type: ' +
          event!.type,
        err
      );
      res.sendStatus(200);
    }
  });
  return middlewares;
};

// ── internals ────────────────────────────────────────────────────────

interface ParsedSignature {
  timestamp: number;
  v1: string;
}

const coerceHeader = (v: string | string[] | null | undefined): string | null => {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
};

const parseSignatureHeader = (raw: string): ParsedSignature | null => {
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=', 2);
    if (!key || !value) continue;
    if (key.trim() === 't') {
      const n = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key.trim() === 'v1') {
      v1 = value.trim();
    }
  }
  if (timestamp === null || v1 === null) return null;
  return { timestamp, v1 };
};

const safeHexEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
};

// Inline Express shape so the SDK has zero peer deps on @types/express.
interface ExpressRequest {
  body: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
}
interface ExpressResponse {
  status: (code: number) => ExpressResponse;
  send: (body: string) => ExpressResponse;
  sendStatus: (code: number) => ExpressResponse;
}
type MiddlewareFn = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: (err?: unknown) => void
) => void | Promise<void>;

// Raw-body parser. Caps at 1 MiB — webhook payloads are ~5 KB; anything larger
// is almost certainly malicious.
const rawBodyMiddleware = (): MiddlewareFn => {
  return (req, _res, next) => {
    // Minimal duck-type cast — avoids importing node:http for a public-facing dts.
    const stream = req as unknown as {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const LIMIT = 1024 * 1024; // 1 MiB

    stream.on('data', (chunk: unknown) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalSize += buf.length;
      if (totalSize > LIMIT) {
        next(new Error('Webhook body exceeds 1 MiB safety limit'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => {
      req.body = Buffer.concat(chunks);
      next();
    });
    stream.on('error', (err: unknown) => next(err));
  };
};
