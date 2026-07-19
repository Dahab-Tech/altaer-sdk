import { createHmac, timingSafeEqual } from 'crypto';
import { SignatureVerificationError } from './errors';
import type { WebhookEvent } from './types';

// Webhook signature verification + typed parsing.
//
// Altaer signs every outbound webhook with HMAC-SHA-256 over
// `${timestamp}.${rawBody}` using your `webhookSecret`. The header is
//   X-Altaer-Signature: t=<unixSeconds>,v1=<hexHmac>
// (same scheme Stripe uses for `Stripe-Signature`).
//
// Verification is two checks:
//   1. The HMAC over `t.body` matches the v1 hex in the header.
//      → constant-time compared via timingSafeEqual to defeat timing
//        attacks.
//   2. `t` is within `toleranceSec` of now. Prevents replay attacks
//        where someone captured a valid signed body weeks ago and tries
//        to replay it. Default 5 minutes (Stripe default).
//
// On any failure → throws SignatureVerificationError. The .reason field
// distinguishes 'missing_header' / 'malformed_header' / 'expired' /
// 'bad_signature' so you can log/alert appropriately.

const SIGNATURE_HEADER = 'x-altaer-signature';
const DEFAULT_TOLERANCE_SEC = 5 * 60;

export interface VerifyWebhookInput {
  /** Raw request body bytes EXACTLY as sent by Altaer. CRITICAL: do
   *  NOT parse JSON before passing it here — re-stringifying may
   *  reorder keys, which invalidates the signature. Use raw-body
   *  middleware (Express: `express.raw({ type: 'application/json' })`). */
  body: string | Buffer;
  /** Value of the `X-Altaer-Signature` request header. */
  signature: string | string[] | null | undefined;
  /** Your webhook secret (`whsec_...`). Auto-minted at workspace
   *  create and revealed on the hub's /developers page. Rotate from
   *  the same page — never auto-rotates, so rotate manually and
   *  verify the new secret works before retiring the old one. */
  secret: string;
  /** Max age of the signed timestamp, in seconds. Older signatures are
   *  rejected to prevent replay. Default 300 (5 minutes). */
  toleranceSec?: number;
}

/** Verify a webhook signature and return the typed event. Throws
 *  SignatureVerificationError on any failure (missing header,
 *  malformed, expired, signature mismatch).
 *
 *  Example (Express):
 *    app.post('/webhooks/altaer',
 *      express.raw({ type: 'application/json' }),
 *      (req, res) => {
 *        const event = verifyWebhook({
 *          body: req.body,
 *          signature: req.headers['x-altaer-signature'],
 *          secret: process.env.ALTAER_WEBHOOK_SECRET!,
 *        });
 *        // event is typed — narrow on event.type
 *        if (event.type === 'order.completed') {
 *          event.data.financials!.deliveryFee; // ← typed
 *        }
 *        res.sendStatus(200);
 *      }
 *    );
 */
export const verifyWebhook = (input: VerifyWebhookInput): WebhookEvent => {
  const header = _coerceHeader(input.signature);
  if (!header) {
    throw new SignatureVerificationError('Missing X-Altaer-Signature header', 'missing_header');
  }

  const parsed = _parseSignatureHeader(header);
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

  if (!_safeHexEqual(expected, parsed.v1)) {
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

/** Express-style middleware factory. Composes the raw-body parser, the
 *  signature verify, and your event handler into one mount point.
 *
 *  Failure model — how each outcome interacts with Altaer's delivery
 *  loop (which retries any non-2xx or timeout up to 12 times):
 *    • Signature invalid  → 400. Altaer sees non-2xx and retries; the
 *                           path is unrecoverable so it dead-letters
 *                           after 12 attempts. Fix your `secret`.
 *    • Handler throws     → SDK swallows the error, logs to
 *                           console.error, and responds 200. No
 *                           retries — the same bug would just throw
 *                           again 11 more times. Watch your own log
 *                           for the "webhook handler threw" line.
 *    • Handler hangs      → Altaer times out (5 s) → non-2xx → retries
 *                           12×. Guard slow branches with your own
 *                           timeout.
 *    • Handler returns    → 200, done. No retry.
 *
 *  Express ≥4.16 has `express.raw` built in; no extra deps.
 *
 *  Example:
 *    import express from 'express';
 *    import { altaerWebhookRoute } from '@dahab-tech/altaer-sdk';
 *
 *    app.post('/webhooks/altaer', altaerWebhookRoute(
 *      { secret: process.env.ALTAER_WEBHOOK_SECRET! },
 *      async (event) => {
 *        switch (event.type) {
 *          case 'order.completed': await markOrderPaid(event.data.id); break;
 *          case 'order.canceled':  await refundWorkspace(event.data.id); break;
 *        }
 *      }
 *    ));
 */
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
    middlewares.push(_rawBodyMiddleware());
  }
  // `_next` (underscore-prefixed) tells TS the parameter is
  // intentionally unused. We keep the 3-arg arity so Express treats
  // this as a regular request middleware, not an error middleware
  // (which would be `(err, req, res, next)`).
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
        // 400 — the request never authenticated. Don't leak details
        // in the body; the reason is in the SDK error for logging.
        res.status(400).send('Invalid signature');
        return;
      }
      // Handler bug. Log loudly on the tenant's side and 200 back so
      // Altaer stops trying — retries won't fix a code path that
      // always throws. The tenant is expected to notice from their
      // own log/error tracker and fix. event is guaranteed non-null
      // here: verifyWebhook throws only SignatureVerificationError,
      // which was caught by the branch above; anything landing here
      // came from the handler, after event was assigned.
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

const _coerceHeader = (v: string | string[] | null | undefined): string | null => {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
};

const _parseSignatureHeader = (raw: string): ParsedSignature | null => {
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

const _safeHexEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
};

// Minimal Express types — kept inline so the SDK has zero peer deps on
// @types/express. Anything compatible (Fastify wrapped, etc.) works as
// long as it implements this shape.
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

// Default raw-body parser. Reads the entire request stream into a
// Buffer before signature verification runs. Caps at 1 MiB — webhook
// payloads are tiny (~5 KB typical) so anything above this is almost
// certainly malicious.
const _rawBodyMiddleware = (): MiddlewareFn => {
  return (req, _res, next) => {
    // Cast to the streaming surface — minimal duck-typing so we don't
    // need to import IncomingMessage from node:http (keeps the public
    // dts clean).
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
