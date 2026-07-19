# Changelog

All notable changes to `@dahab-tech/altaer-sdk` are documented here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.24] — 2026-07-19

Docs pass. No code / contract change.

### Changed

- **README rewritten** to mirror the intro at [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api) — same structure, same tone, so the two surfaces read as one. Getting started + Webhooks + Local development + Conventions + Errors sections all present.
- **`homepage`** now points at [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api) so npm's sidebar sends visitors directly to the reference.
- **`repository` + `bugs`** now point at the public source mirror [github.com/Dahab-Tech/altaer-sdk](https://github.com/Dahab-Tech/altaer-sdk) instead of the private monorepo. Every published version has a matching `vX.Y.Z` tag on that repo so consumers can browse source at exactly the version they installed.

## [0.0.23] — 2026-07-19

Docs pass, no contract changes. Existing `0.0.22` code keeps working; upgrade only for the improved IDE tooltips.

### Changed

- **`orders.create` JSDoc** now mentions `simulation` up front — pass it on sandbox to run a robot driver through the full lifecycle in ~15s (existing `simulation` enum unchanged).
- **`orders.list`, `finance.ledger`, `finance.settlements` samples** trimmed — leading `//` comment walls duplicated info already on the `since` / `until` parameter docstrings, so revisits to those methods no longer render as a grey block in `/docs/api`.
- **Sandbox-simulation code sample** collapsed onto the `simulation:` line as a single trailing hint (`// or driver_cancel_pre_pickup / … / random`).

### Fixed (server-side, no SDK API change)

- **Webhook envelope `created` is now byte-stable on retries** — was being restamped per delivery attempt; now snapshotted at enqueue-time and preserved across the retry chain. Matches the Stripe convention the SDK types already documented. Consumers dedup'ing on `id + created` see the same value they saw on the first attempt.

### Internal

- Regenerated `src/generated/api.ts` from the docs-updated `openapi.yaml`. No schema field / method signature drift — types are structurally identical to `0.0.22`; only description strings changed.

## [0.0.22] — 2026-07-15

**BREAKING — trusted-fleet model.** Altaer's separate "pool" of directly-managed drivers is gone. Deliveries not fulfilled by your own operator's fleet are fulfilled by the **Altaer network** — trusted operator fleets dispatched cross-workspace — and the contract presents them uniformly as `platform`, with no per-delivery fulfiller identity. Envelope `apiVersion` is now `2026-07-15`.

### Changed

- **Settle events renamed** — `workspace.altaer_pool_balance.settled` → `workspace.altaer_balance.settled`, `workspace.altaer_pool_balance.reversed` → `workspace.altaer_balance.reversed`. Payload shapes are unchanged (`amount`, `direction`, `breakdown`, …); only the event name and its envelope `type` move. Update your `switch (event.type)` cases.
- **Type renames to match:** `AltaerPoolBalanceSettledPayload` → `AltaerBalanceSettledPayload`, `AltaerPoolBalanceReversedPayload` → `AltaerBalanceReversedPayload`.
- **`FulfilledBy` platform variant reshaped** — `{ kind: 'pool', providerId, providerName }` is now `{ kind: 'platform' }`. Which network fleet ran the delivery is Altaer's dispatch concern, not part of the partner contract, so no identity fields are exposed. The `{ kind: 'fleet', fleetId, fleetName, ownerOperatorId }` variant (your operator's own fleet) is unchanged, as is `null` while unassigned.
- **Trust events renamed** — `fleet.pool_trust.granted` / `fleet.pool_trust.revoked` → `fleet.trust.granted` / `fleet.trust.revoked`. Trust now means: the fleet's drivers can accept platform-dispatched orders from any workspace on Altaer.

### Removed

- **`OrderFinancials.withholdingAmount`** — withholding tax is resolved at payout time between Altaer and its drivers / operators; it was never part of what a workspace owes, and the per-order snapshot had no consumer. Nothing replaces it in the partner contract.

### Added

- **`fleet.trust.granted` / `fleet.trust.revoked` are now typed** — previously emitted on the wire but missing from `WebhookEventType` and the `WebhookEvent` union, so handlers couldn't narrow on them. New payload aliases: `FleetTrustGrantedPayload` (`{ occurredAt, fleet, note, grantedByAdminId }`), `FleetTrustRevokedPayload` (`{ occurredAt, fleet, revokedByAdminId }`).

### Internal

- Regenerated `src/generated/api.ts` from the updated `docs/openapi/openapi.yaml` (spec examples, schemas, and `x-codeSamples` all speak platform/fleet; envelope examples stamp `apiVersion: '2026-07-15'`).

## [0.0.21] — 2026-07-12

Date-range filtering on the list operations, plus editorial cleanup on the spec.

### Added

- **`since` / `until` on `orders.list`, `finance.ledger`, `finance.settlements`.** Inclusive `YYYY-MM-DD` bounds on the row's `createdAt`; omit either side for unbounded. Composes with `limit` / `offset`, so date-scoped queries like monthly reconciliation stop having to paginate through everything to reach the target window: `await al.orders.list({ since: '2026-06-01', until: '2026-06-30', limit: 100 })`. Bad-format dates 400 instead of being silently ignored.

### Changed

- Order-creation request schema renamed: `CreateOrderRequest` → `OrderCreate`. The friendly SDK export `CreateOrderInput` is unchanged.
- Dead "ThirdParty" vocabulary that predated the "workspace" rebrand is gone from field docstrings and inline comments across the spec.

## [0.0.20] — 2026-07-10

Tracking is now a full streaming client, not just a socket wrapper: shared subscriptions with independent listeners, instant last-position replay for late joiners, and a `terminal` flag that tells you when the SDK has stopped retrying. Docs consolidated into the hosted reference. The wire protocol is unchanged — no server upgrade needed.

### Added

- **Listener multiplexing on `tracking.subscribe()`.** Subscribing to the same order again now ADDS an independent listener over the one shared server-side subscription instead of replacing the previous handlers. Each returned handle detaches only itself via `unsubscribe()`; the wire subscription (and the socket, if it was the last order) is released when the final listener detaches. Two screens tracking the same order no longer fight over one callback slot, and N listeners still count once against the plan's subscription limit.
- **Last-known-location replay.** A listener attaching to an order that is already streaming receives the most recent cached position immediately (asynchronously, after `subscribe()` resolves), then live pushes — late joiners no longer stare at an empty map until the driver next moves.
- **`TrackingError.terminal: boolean`.** `true` = the server would refuse this order forever (`order_terminal`, `not_found_or_forbidden`, `subscription_limit_exceeded`, `invalid_orderId`) and the SDK has already stopped renewing/resubscribing it; `false` = transient (socket drop, ack timeout) and the SDK keeps retrying on reconnect. Consumers no longer need their own hardcoded terminal-code lists to decide when to give up.

### Fixed

- Terminal refusals during lease renewal or reconnect-resubscribe previously kept the subscription registered and retried forever (looping the same refusal every reconnect); they now tear the subscription down before dispatching `onError`.
- A failed first-ever `subscribe()` (e.g. server unreachable) leaked a socket that kept reconnecting forever with nothing subscribed; the socket is now dropped when the last (or only) subscription attempt fails.
- `subscribe()` rejections are now always `TrackingError`-shaped (transport failures included), so one `catch` shape handles everything.

### Changed

- **The complete integration guide moved to [altaer.app/docs/api](https://altaer.app/docs/api); this README is now a landing page.** All documentation is consolidated into the OpenAPI spec (`docs/openapi/openapi.yaml`): every operation carries its SDK call (`x-codeSamples`) next to the request/response schemas, so the guide, the SDK types, and the wire contract are one artifact that can never drift.
- Live tracking is a first-class **Tracking** reference entry (documented as the real `GET /socket.io` handshake) instead of a guide section; the generated types gain an inert `/socket.io` path entry. Every `order.*` webhook now shows a realistic per-event example payload (`financials` only on `order.completed` / `order.canceled`, driver block `null` before assignment).
- `package.json` now declares the `repository` field, linking the npm page back to the source repo.
- `INSTALL.md` (repo-only, never shipped in the tarball) is deleted — its content lives in the hosted docs' Getting started.

## [0.0.19] — 2026-07-10

The SDK now covers 100% of the tenant API — no endpoint requires a raw HTTP call anymore — and installs from the public npm registry with no auth setup.

### Added

- **`client.workspace.*` resource** — the four self-service workspace endpoints, previously reachable only via raw HTTP:
  - `workspace.getProfile()` → your sanitized workspace profile (`WorkspaceProfile`).
  - `workspace.updateProfile(input)` → partial update of `name`, `tradeName`, `businessAddress`, `industry`, `operatingHours`, `timeZone`. Unknown fields are rejected with a 400 — nothing is silently dropped.
  - `workspace.rotateCredentials()` → replaces the API key; the new key is in the response once and never retrievable again.
  - `workspace.setWebhookUrl(url | null)` → point webhook delivery at a new consumer URL, or clear it.
- New exported types: `WorkspaceProfile`, `UpdateWorkspaceProfileInput`, `WorkspaceIndustry`, `OperatingHours`, `WorkspacePricing`, `RotateCredentialsResponse`, `SetWebhookUrlResponse`.

### Changed

- **Registry moved to public npmjs.** `npm install @dahab-tech/altaer-sdk` now works with zero configuration — the GitHub Packages `.npmrc` + `NPM_TOKEN` setup is gone. License is MIT (the SDK client only; the Altaer platform itself is unaffected).
- `GET /workspaces/profile` (server-side) now returns an explicit whitelist (`WorkspaceProfile`) instead of the raw workspace document, and `PUT /workspaces/profile` accepts only the six updatable fields. Integrations that read undocumented fields off the old raw response must switch to the documented shape.
- **README is now the complete integration guide.** One document, organized by resource (Orders / Finance / Workspace / Live tracking / Webhooks / Errors), each method with usage, required fields, and response examples — it replaces the monorepo's `docs/API.md` + `docs/API_REFERENCE.md`, which are deleted. Raw HTTP integrators use the OpenAPI spec (rendered at `/docs/api`).
- `orders.cancel` docblocks no longer claim the server ignores `canceledBy` — `pickup` / `dropoff` / `workspace` attribution has been honored since the cancel-attribution feature landed; the comment predated it.

### Internal

- Regenerated `src/generated/api.ts` from the updated `docs/openapi/openapi.yaml` (adds the `Workspace` tag + 4 paths).

## [0.0.18] — 2026-07-10

Removes a phantom event type. No runtime wire change — the event never fired.

### Removed

- **`workspace.operator_fleet_balance.reversed`** dropped from `WebhookEventType`, the `WebhookEvent` union, and the exported payload aliases (`OperatorFleetBalanceReversedPayload` is gone). The event was documented but had no emit path on the server: operator-fleet balance records are off-platform bookkeeping (Altaer moves no money), and no correction/reversal flow exists for them — only PSP-collected settlements are refundable. Handlers written against it never matched a real event. `workspace.operator_fleet_balance.recorded` is unchanged.

### Internal

- Regenerated `src/generated/api.ts` from the updated `docs/openapi/openapi.yaml` (spec version `2026-07-10`).

## [0.0.17] — 2026-07-09

Spec catch-up + list-endpoint repair. Wire changes are additive; the one type change (`FulfilledBy`) corrects a shape the server never actually sent.

### Fixed

- **`orders.list()` now works.** The server previously returned a bare array of raw DB rows while the SDK typed (and the spec promised) a `{ items, total, limit, offset }` envelope — every typed access on the result was wrong. The server now returns the documented envelope, `total` included, with rows in the same whitelisted `Order` shape as `orders.get()` (raw internal fields like commission amounts no longer leak). `limit` is clamped server-side to 1–100.
- **`FulfilledBy` type corrected** — the spec described an `{ ownerType, providerId, ... }` object that the server never sent. It now matches the real wire shape: a union discriminated on `kind` — `{ kind: 'pool', providerId, providerName }` or `{ kind: 'fleet', fleetId, fleetName, ownerOperatorId }` — or `null`.
- **Fleet webhook event names corrected** — the spec and SDK typed five events as `provider.created` / `provider.deleted` / `provider.driver.added` / `provider.driver.released` / `provider.driver.transferred`, but the wire has always sent `fleet.created` / `fleet.deleted` / `fleet.driver.added` / `fleet.driver.released` / `fleet.driver.transferred` with `fleet` / `fromFleet` / `toFleet` payload keys. Types renamed to match: `FleetSnapshot` replaces `ProviderSnapshot` (`{ id, name, brandingName, ownerOperatorId }` — no `ownerType`), and payload aliases are now `FleetCreatedPayload`, `FleetDeletedPayload`, `FleetDriverAddedPayload`, `FleetDriverReleasedPayload`, `FleetDriverTransferredPayload`. Handlers written against the old names never matched a real event.
- `User-Agent` version stamp had drifted from the package version (`0.2.3` leftover from the pre-rename scheme); both now read `0.0.17`.

### Added

- **`Order.trackingUrl` / `Order.trackingToken`** — the public end-customer share-link, now on every order surface: create response, `orders.get()`, `orders.list()` rows, and `order.*` webhook payloads.
- **`financials` on `orders.get()`** — once an order reaches a terminal financial outcome, polling the single order returns the same `OrderFinancials` snapshot the terminal webhooks push, so a missed webhook can be reconciled by polling. Never present on list rows.
- **`orders.get()` field parity with webhooks** — the single-order response now carries the full `Order` shape (`externalOrderId`, cancel fields, ETAs, buy-at-pickup echo, tracking fields). Driver fields are explicit `null` when unassigned instead of absent.
- **Create response is a full `Order`** — `orders.create()` now returns the same whitelisted shape as `orders.get()` (driver fields `null`, no `financials`) instead of a 5-field subset missing the spec-required `currency` / `origin`.
- **`AltaerError.data`** (`Record<string, unknown> | null`) — typed access to the error envelope's optional structured context, previously only reachable through the raw `body`. Shape depends on `code`.
- **Documented `order/fleet_commission_above_delivery_fee`** — 400 from `orders.create` and `orders.quote` when a fleet-dispatched route's commission + VAT meets or exceeds the delivery fee (the driver would earn nothing). Its `error.data` carries `{ platformInvoiceAmount, deliveryFee }` in integer minor units, so you can show the exact amounts without re-quoting.
- **Buy-at-pickup echo on webhooks** — `order.*` webhook payloads now include `isBuyAtPickup` / `buyAtPickupEstimateToPay` / `buyAtPickupPaidByDriver` (the spec already promised them on `Order`).

### Internal

- Regenerated `src/generated/api.ts` from the updated `docs/openapi/openapi.yaml` (spec version `2026-07-09`).

## [0.0.7] — 2026-06-30

**BREAKING — partner contract simplification.** Drops the `independentHub` workspace flag, the `partnerScope` settlement discriminator, and the api/hub-scoped variants of the pool-balance settled payload. Events now carry enough metadata for partners to filter their own slice client-side. Closer to Stripe-shaped: events are facts, partners filter.

### Wire changes

**`workspace.altaer_pool_balance.settled` payload** — collapsed from a discriminated `scope: 'api' | 'all'` union to a single shape. Every payload now carries `amount` (full workspace-level settle magnitude), `direction` (workspace-level direction), and `breakdown: { api, hub, unknown }` (signed per-origin slices). Partners read `breakdown.<origin>` to extract their slice.

**`workspace.altaer_pool_balance.reversed` payload** — gains a required `breakdown` field (verbatim copy of the original settle's, sign-preserved). Partners apply forward via `weOwe -= breakdown.api` and reversal via `weOwe += breakdown.api` — symmetric by construction.

**Order events** — fire for **every** workspace order regardless of origin. Partner filters on `data.origin` ('api' / 'hub') at the handler level. Previously hub-origin order events were gated by `independentHub: false`; now partners decide what to act on. Existing handlers that only acted on api orders need a one-line guard: `if (data.origin !== 'api') return;`.

### New endpoint

**`GET /api/v1/workspaces/me/finance/settlements/:id`** — returns the settlement plus a flat `items[]` array of every per-order ledger contribution it covered. Each item carries `orderId`, `externalOrderId`, `origin`, `type`, `amount` (signed), and `createdAt`. Use for line-by-line audit when the webhook's `breakdown` totals aren't enough; most reconciliation can skip this.

New SDK helper: `client.finance.getSettlement(id)`.

### Renamed / removed types

- **Removed:** `ApiScopedAltaerPoolBalanceSettledPayload`, `AllScopedAltaerPoolBalanceSettledPayload` — discriminator gone; just use `AltaerPoolBalanceSettledPayload`.
- **Added:** `OriginBreakdown` — the signed per-origin slice shape, reused on settle / reversal / `Settlement.breakdown`.
- **Added:** `SettlementItem`, `SettlementWithItems` — return type of `getSettlement(id)`.

### Migration

```diff
- case 'workspace.altaer_pool_balance.settled':
-   if (event.data.scope === 'api') {
-     applyApiSlice(event.data.amount);
-   } else {
-     applyApiSlice(event.data.breakdown.api);
-   }
+ case 'workspace.altaer_pool_balance.settled':
+   applyApiSlice(event.data.breakdown.api);  // signed, sign-aware
+   break;

- case 'workspace.altaer_pool_balance.reversed':
-   applyApiSlice(-event.data.amount);  // total amount, no breakdown
+ case 'workspace.altaer_pool_balance.reversed':
+   applyApiSlice(event.data.breakdown.api);  // sign-preserved copy
+   break;

- case 'order.completed':
-   // (only api orders fired previously)
-   processOrder(event.data);
+ case 'order.completed':
+   if (event.data.origin !== 'api') return;  // partner filters
+   processOrder(event.data);
```

### Why this exists

The `independentHub` flag actually controlled two things — webhook gating AND ledger self-billing avoidance. After the refactor, self-billing is detected from actual workspace-operator-fleet ownership (no manual toggle), and webhook gating is the partner's decision. The merged design removed ~300 lines of server-side conditional logic and the entire class of "mixed-sign breakdown" bugs that plagued the earlier scope discriminator.

Server-side bump: `apiVersion` on the wire is now `2026-06-30`.

## [0.0.6] — 2026-06-29

Metadata-only release — no wire-format, type, or runtime behavior changes.

- Bumped `info.version` in `docs/openapi/openapi.yaml` from `'2026-06-27'` to `'2026-06-29'` so the spec's stated version matches the `apiVersion` the server actually stamps on outbound webhook envelopes. (The 0.0.5 cut shipped with the spec dated two days behind the wire, harmless but inconsistent.)
- Regenerated `src/generated/api.ts` — diff is empty (openapi-typescript doesn't surface `info.version` in the generated output). The regeneration is run for completeness.

No consumer action needed. Existing 0.0.5 integrations work identically on 0.0.6.

## [0.0.5] — 2026-06-29

**BREAKING — settlement event rename.** The three overloaded settlement events have been replaced with six counterparty-prefixed events. Each event now represents exactly one money flow; no more payload introspection needed to know which scenario fired.

### Renamed events

| Before | After (depends on which scenario) |
| --- | --- |
| `workspace.settlement_paid` | `workspace.altaer_pool_balance.settled` |
| `workspace.settlement_reversed` (pool reversal) | `workspace.altaer_pool_balance.reversed` |
| `workspace.settlement_reversed` (commission reversal) | `workspace.altaer_fleet_commission.reversed` |
| `workspace.operator_settlement_recorded` (commission settle fan-out) | `workspace.altaer_fleet_commission.settled` |
| `workspace.operator_settlement_recorded` (off-platform record) | `workspace.operator_fleet_balance.recorded` |
| (didn't exist) | `workspace.operator_fleet_balance.reversed` (NEW — for correcting a prior off-platform record) |

### Renamed payload types

- `SettlementPayload` → `AltaerPoolBalanceSettledPayload`
- `ApiScopedSettlementPayload` → `ApiScopedAltaerPoolBalanceSettledPayload`
- `AllScopedSettlementPayload` → `AllScopedAltaerPoolBalanceSettledPayload`
- `SettlementReversedPayload` → split into `AltaerPoolBalanceReversedPayload` + `AltaerFleetCommissionReversedPayload`
- `OperatorSettlementRecordedPayload` → split into `AltaerFleetCommissionSettledPayload` + `OperatorFleetBalanceRecordedPayload`
- New: `OperatorFleetBalanceReversedPayload`

### Naming convention

Event name pattern is now `workspace.<counterparty>_<balance>.<action>`:

- counterparty ∈ {`altaer`, `operator`} — who's on the other side of the balance
- balance ∈ {`pool_balance`, `fleet_commission`, `fleet_balance`} — which ledger pair
- action ∈ {`settled`, `recorded`, `reversed`} — `settled` means money moved through Altaer; `recorded` means off-platform memorialization; `reversed` is the inverse of either

Direction (in/out) is on the payload's `direction` field, never in the event name.

### Migration

```diff
- case 'workspace.settlement_paid':
+ case 'workspace.altaer_pool_balance.settled':
-   const payload = event.data as SettlementPayload;
+   const payload = event.data as AltaerPoolBalanceSettledPayload;
    if (payload.scope === 'all') { ... }

- case 'workspace.operator_settlement_recorded':
-   // Was overloaded; you had to guess if it was commission or off-platform.
+ case 'workspace.altaer_fleet_commission.settled':
+   // Operator paid Altaer's commission for this workspace's orders.
+   const slice = event.data as AltaerFleetCommissionSettledPayload;
+
+ case 'workspace.operator_fleet_balance.recorded':
+   // Operator and workspace squared up off-platform.
+   const record = event.data as OperatorFleetBalanceRecordedPayload;

- case 'workspace.settlement_reversed':
+ case 'workspace.altaer_pool_balance.reversed':
+ case 'workspace.altaer_fleet_commission.reversed':
+ case 'workspace.operator_fleet_balance.reversed':
```

Old event names removed entirely — no deprecation period (SDK is pre-1.0, breaking changes are expected per patch bumps).

## [0.0.4] — 2026-06-29

Type-only drift fix + documentation update for the platform-commission settle path (server Stage A.6/A.7/A.8). No wire-format changes; existing consumers continue to receive the same events with the same payloads. The fan-out behavior described below was already live on the server; this release ensures the SDK's TypeScript surface and OpenAPI descriptions accurately reflect it.

**Added (type-only):**

- `SettlementReversedPayload` re-exported from `@dahab-tech/altaer-sdk` for partners who want to annotate variables directly against the payload (previously the schema existed in the generated layer but wasn't surfaced in the hand-written types).
- `'workspace.settlement_reversed'` added to the `WebhookEventType` union and to the `WebhookEvent` discriminated union, so `switch (event.type)` narrowing now works for reversal events.

**Behavior clarifications (no contract change):**

- `workspace.operator_settlement_recorded` now documented as covering BOTH the workspace↔operator off-platform settle (the original case) AND the platform-commission settle fan-out (one event per workspace contributing to the operator's total commission settle, sharing `settlementId`).
- `workspace.settlement_reversed` documented as also fanning out per workspace when reversing an platform-commission settle. Each per-workspace slice arrives as its own event; group by `originalSettlementId`.

## [0.0.3] — 2026-06-27

Tracks the `2026-06-27` OpenAPI revision. **BREAKING — terminology rename.** Every `customer` / `Customer` identifier in the public surface has been renamed to `workspace` / `Workspace` (the user-facing term hub operators already see). Internal-only change for our team; consumers must update their event-type switches, type imports, and any hard-coded references.

**Renamed events:**

| Before | After |
| --- | --- |
| `customer.settlement_paid` | `workspace.settlement_paid` |
| `customer.settlement_reversed` | `workspace.settlement_reversed` |
| `customer.operator_settlement_recorded` | `workspace.operator_settlement_recorded` |

**Renamed schemas / types:**

- `Customer*` → `Workspace*` everywhere (e.g., `ICustomerDto` → `IWorkspaceDto`, `CustomerId` → `WorkspaceId`)
- Settlement payload `customerId` field → `workspaceId`
- All endpoint path segments `/customers/` → `/workspaces/`

**NOT renamed (preserved as-is):**

- `stripeCustomerId` (Stripe SDK concept on operator record)
- `paymobCustomerId` (Paymob saved-token customer)
- Any `StripeCustomer*` / `PaymobCustomer*` identifiers — these refer to the PSP's customer object, not ours

**Migration for consumers:**

```diff
- case 'customer.settlement_paid':
+ case 'workspace.settlement_paid':
-   await mirror(event.data.customerId, ...);
+   await mirror(event.data.workspaceId, ...);
```

```diff
- import type { components } from '@dahab-tech/altaer-sdk';
- type Payload = components['schemas']['SettlementPayload'];
+ type Payload = components['schemas']['SettlementPayload']; // same name, but inner field is workspaceId now
```

For `customerId` in your DB joins, you'll want a one-shot rename script if you've been persisting these. The numeric IDs themselves don't change — only the field/event names.

## [0.0.2] — 2026-06-26

Tracks the `2026-06-26` OpenAPI revision. Additive only — no breaking changes; consumers can upgrade by bumping the dependency.

**Added:**

- `workspace.settlement_reversed` webhook event + `SettlementReversedPayload` schema. Fires when a prior `workspace.settlement_paid` is reversed by PSP refund, dispute (Stripe chargeback opened / closed-as-won), Connect transfer reversal, or Paymob refund/void. Carries `originalSettlementId` for joining with the original.
- README section "Settlement events — `partnerScope` and `independentHub`" explaining when settlement webhooks fire / don't fire and how `independentHub` drives the `'api'` / `'all'` / `'skipped'` decision.
- README inline example now shows reversal-handling pattern.
- `workspace.operator_settlement_recorded` listed in the events table (was already supported by the SDK but undocumented).
- Expanded `method` field description on settlement payloads to document the full list of PSP-emitted labels (`stripe_checkout`, `paymob_checkout`, `stripe_refund`, `paymob_refund`, `stripe_dispute`, `stripe_dispute_won`, `stripe_transfer_reversal`, `manual_cash`, plus saved-method kinds).

**Unchanged (no migration needed):**

- All existing event names, payload field types, and method signatures.
- `verifyWebhook` / `expressWebhookHandler` / `SignatureVerificationError` behavior.

## [1.0.0] — 2026-06-19

First stable release of `@dahab-tech/altaer-sdk` — the official Node.js / TypeScript SDK for the Altaer delivery dispatch API.

**Public surface:**

```ts
import { AltaerClient, AltaerError } from '@dahab-tech/altaer-sdk';

const al = new AltaerClient({ apiKey: process.env.ALTAER_API_KEY! });

app.post('/webhook', (req, res) => {
  const sig = req.headers['x-altaer-signature'];
  // ... verify + handle
});
```

**Defaults:**

- Base URL: `https://altaer.app` (staging: `https://staging.altaer.app`)
- Webhook signature header: `X-Altaer-Signature` / `x-altaer-signature`
- API auth header: `x-api-key`
- Webhook signing scheme: HMAC-SHA-256 over `${unix_t}.${rawBody}`, header value `t=<unix>,v1=<hex>`, 5-minute replay window
- Auto-retries on 5xx + network errors with full-jitter exponential backoff (200ms → 5s, up to 3 retries by default)
- Auto `Idempotency-Key` (UUID v4) on every POST

## [0.4.1] — 2026-06-16

Re-release of 0.4.0 with the CI lint + hub-workspace tsc fixes bundled. The wire format is identical to 0.4.0; this version exists because 0.4.0 was tagged on a commit that failed CI (an eslint-disable directive that prettier reformatted around + a stale `vatAmount` reference in the `hub/` Expo workspace). 0.4.0 was never published to npm.

Migration from ≤ 0.3.x is identical to what 0.4.0's notes describe below.

## [0.4.0] — 2026-06-16

### Breaking — field rename on webhook + quote payloads

Pool and fleet orders previously exposed two different field names for "what Altaer bills for this delivery" — `platformCommission` on pool quote responses and `commissionRate` on fleet quote responses and on the financials webhook. They referred to the same economic concept (the platform's commission cut and the rate that produced it) so they have been unified to one name:

| Old field name (≤ 0.3.3) | New field name (≥ 0.4.0) |
| ------------------------ | ------------------------ |
| `commissionRate`         | `platformCommissionRate` |

The rename affects:

- `IThirdPartyFinancialsDto` (the `financials` block on webhook events and on `IThirdPartyDeliveryResponseDto`).
- `IThirdPartyDeliveryQuoteResponseDto` (the response of `client.orders.quote(...)`).

Other fields are **unchanged** and continue to carry their existing distinct meanings:

- `extraCommissionAmount` (pool only) — Altaer's bonus cut on top of the base commission. Money goes to Altaer; this is NOT a Provider payout.
- `operatorMargin` (fleet only) — the operator's per-delivery profit margin. Money goes to the operator (NOT Altaer).
- `platformInvoiceAmount` — gross with VAT (`platformFee + platformFeeVat`). Counterparty differs by `dispatchSource` (workspace owes on pool, operator owes on fleet).

### Migration

Search-and-replace in your integration code:

```sh
# Replace the field name everywhere it's read from a webhook / quote.
grep -rln 'commissionRate' src/ | xargs sed -i 's/\bcommissionRate\b/platformCommissionRate/g'
```

The wire payload otherwise has the same shape — no DTOs were removed, no fields semantically changed meaning. If your code only reads `deliveryFee` / `platformInvoiceAmount` / `driverEarning`, you don't need to do anything.

### Internal

- Regenerated `src/generated/api.ts` from the updated `docs/openapi/openapi.yaml`. Run `npm run generate:types` after pulling for local development.

---

## [0.3.x] and earlier

Prior history is in git only — this file starts at 0.4.0.
