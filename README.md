# @dahab-tech/altaer-sdk

[![Docs](https://img.shields.io/badge/%F0%9F%93%96_Docs-hub.altaer.app%2Fdocs%2Fapi-FFCE0A?labelColor=1C5E83)](https://hub.altaer.app/docs/api) [![Hub](https://img.shields.io/badge/%F0%9F%9A%9A_Hub-hub.altaer.app-1C5E83?labelColor=FFCE0A)](https://hub.altaer.app) [![npm](https://img.shields.io/npm/v/@dahab-tech/altaer-sdk?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/@dahab-tech/altaer-sdk) [![License MIT](https://img.shields.io/npm/l/@dahab-tech/altaer-sdk)](./LICENSE) [![Node](https://img.shields.io/node/v/@dahab-tech/altaer-sdk?logo=node.js)](https://nodejs.org)

Dispatch deliveries on [Altaer](https://altaer.app)'s driver network from your own system: create orders, stream live driver GPS, receive webhooks, reconcile your balance. One typed client, no hand-rolled HTTP.

**[hub.altaer.app/docs/api](https://hub.altaer.app/docs/api)** is the full integration reference — every operation with its SDK call, request/response schemas, webhook payloads, error semantics, and the sandbox workflow. This README is the quickstart.

Not on Node? The docs page is generated from an OpenAPI 3 spec you can download at [hub.altaer.app/docs/api/openapi.yaml](https://hub.altaer.app/docs/api/openapi.yaml) and feed to Postman, Insomnia, or any codegen.

## Install

```bash
npm install @dahab-tech/altaer-sdk
```

Requires Node.js 18+ (uses built-in `fetch` and `crypto`). Works in TypeScript and plain JavaScript; types ship inside the package, so editors autocomplete everything either way.

## Getting started

Grab an API key from the hub's **Developers** page, install the SDK, and construct one client at boot to share across handlers:

```ts
import { AltaerClient } from '@dahab-tech/altaer-sdk';

const al = new AltaerClient({
  apiKey: process.env.ALTAER_API_KEY!,
  baseUrl: 'https://staging.altaer.app', // omit for production
});

const order = await al.orders.create({
  merchantAmount: 5000, // integer minor units
  paymentMethod: 'cash',
  externalOrderId: 'ORD-1234',
  pickUpData: {
    contactName: "Mona's Bakery",
    contactPhoneNumber: '+201001234567',
    address: '12 El-Tahrir St, Cairo',
    latitude: 30.0444,
    longitude: 31.2357,
  },
  dropOffData: {
    contactName: 'Ahmed Hassan',
    contactPhoneNumber: '+201005551234',
    address: '8 Mohandessin Ave, Giza',
    latitude: 30.0561,
    longitude: 31.2003,
  },
});

console.log(order.id, order.status, order.trackingUrl);
```

The full SDK surface:\
`al.orders.*` (create / get / list / cancel / redispatch / quote / rate)\
`al.finance.*` (balance / summary / overview / ledger / settlements / statement)\
`al.workspace.*` (profile / rotateCredentials / setWebhookUrl)\
`al.tracking.subscribe()` for live driver GPS.

## Webhooks

Altaer POSTs status changes and account events to your `webhookUrl` (set on `/developers`, or `al.workspace.setWebhookUrl(url)`) with an `X-Altaer-Signature` HMAC header. `altaerWebhookRoute` verifies the signature, hands you a typed event, and responds `200` on any normal return from your handler:

```ts
import { altaerWebhookRoute } from '@dahab-tech/altaer-sdk';

app.post(
  '/webhooks/altaer',
  altaerWebhookRoute(
    { secret: process.env.ALTAER_WEBHOOK_SECRET! },
    async (event) => {
      if (!event.livemode) return; // skip sandbox in prod handler

      try {
        const { id, financials } = event.data;
        switch (event.type) {
          case 'order.completed':
            await markPaid(id, financials!.deliveryFee);
            break;
          case 'order.canceled':
            await refundIfCharged(id, financials);
            break;
          case 'order.no_driver_found':
            await notifyOpsAndRefund(id);
            break;
          default:
            // Unhandled events auto-respond 200 — no retry.
            break;
        }
      } catch (err) {
        console.log('webhook handler failed', event.id, err);
      }
    }
  )
);
```

Non-Express receivers: call `verifyWebhook({ body, signature, secret })` with the **raw request bytes** (not re-parsed JSON) and write your own response. Signature format: `t=<unixSeconds>,v1=<hexDigest>`, HMAC-SHA-256 over `` `${t}.${rawBody}` ``.

**Delivery rules**

- **At-least-once** — dedupe on envelope `id`; order per-order events by `sequence`.
- **Retries fire on non-2xx or timeout** — up to 12 attempts with exponential backoff (~25 min end-to-end), then dead-lettered. Re-send any past event from `/developers/events`.
- **A thrown handler = no retry** — the SDK catches your throw, logs to console, and responds `200`. Signature-verification failures are the exception: those return `400` and retry through to dead-letter (unrecoverable path).
- **A hung handler = retries** — if your code never resolves, Altaer times out the request and treats it as a delivery failure. Guard slow branches with your own timeout.

Every event's exact payload is in the **Webhooks** sidebar section at [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api).

## Local development

Altaer needs a public `https://` URL to POST to — `localhost` is unreachable from the internet. Cloudflare Tunnel gives you one in two commands, free, no signup.

Install on macOS (Homebrew). For Windows / Linux, see [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
brew install cloudflared
```

Start a tunnel pointed at whatever port your app runs on. Use `127.0.0.1` rather than `localhost` — Node 17+ may resolve `localhost` to `::1` (IPv6) first, and `cloudflared` returns "connection refused" when your server only bound to IPv4:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

It prints a fresh https URL like:

`https://busy-flowing-tree-4821.trycloudflare.com`

Paste that into **Developers → Webhook URL** and Save. Every event lands on your local port until you Ctrl+C the tunnel.

## Conventions

- **Money is integer minor units** — piastres, cents, pence. `5000` = E£50.00.
- **Rates are decimals** in `[0, 1]`.
- **Phone numbers are E.164** — `+201001234567`.
- **Timestamps are ISO-8601 UTC** — two exceptions: webhook `created` is unix seconds, tracking `at` is unix milliseconds.
- **Every SDK method takes a trailing `opts`**:
  - `signal` — AbortSignal to cancel the request from your code.
  - `idempotencyKey` — override the auto-generated one.
  - `maxRetries` — how many times the SDK retries a 5xx/network error from Altaer. Client-side, unrelated to webhook retries.

## Errors

Failed SDK calls throw typed classes — use `instanceof`, not status switches. Each carries `statusCode`, `code`, `message`, `requestId` (quote it to support), and the raw `body`:

| Class                 | HTTP            | `code`                           |
| --------------------- | --------------- | -------------------------------- |
| `AuthenticationError` | 401             | `unauthorized`                   |
| `PermissionError`     | 403             | `forbidden`                      |
| `NotFoundError`       | 404             | `not_found`                      |
| `ConflictError`       | 409             | `conflict`                       |
| `ValidationError`     | 400/422         | `validation_error`               |
| `RateLimitError`      | 429             | `rate_limited` (`retryAfterSec`) |
| `ApiError`            | other 4xx/5xx   | server-provided                  |
| `NetworkError`        | 0 (no response) | `network_error`                  |

## License

MIT.

## Support

Contact your Altaer account manager. Include the `requestId` from the error for the fastest resolution.
