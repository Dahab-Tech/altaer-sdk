# Changelog

All notable changes to `@dahab-tech/altaer-sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.33] — 2026-07-24

Contract-shape overhaul. Every entity id is now a **ULID string**, and every ambiguous economics field is replaced with a self-describing `platformInvoice` block. Types are stricter and vocabulary is now consistent between the wire, the SDK, and Altaer's docs.

### Changed

- **All ids are now ULID strings** (`orderId`, `driverId`, `fleetId`, `workspaceId`, `operatorId`, `settlementId`, `originalSettlementId`, `originalOrderId`, `grantedByAdminId`, `revokedByAdminId`, …) — previously mixed `number` / `string`. Time-sortable, URL-safe, 26 characters, Crockford base32. Store as opaque strings.
- **`Order.payment` carries `platformInvoice: { billedTo, purpose, subtotal, vat: { rate, amount }, total }`** — the ONE number the counterparty owes Altaer per order, self-describing.
  - `billedTo` = `'workspace'` on trusted / platform-network deliveries (workspace owes delivery + VAT), `'operator'` on own-fleet deliveries (operator owes commission + VAT).
  - `purpose` = `'delivery'` or `'commission'` accordingly.
  - Replaces the previous ambiguous `platformShare` field, which meant different things by dispatch mode.
- **`Quote.platformInvoice`** — same block on the quote preview so integrations know the exact amount owed BEFORE placing the order.
- **`Order.financials.amounts.platformInvoice`** — same block on the completed-order financials snapshot. Punitive (driver-cancel-post) rows: `subtotal` = recovery amount, `vat.amount` = 0 (no taxable supply).
- **`Order.fleet.commission.amount` / `commission.rate`** — the ledger commission snapshot moved under a grouped `fleet` block on Order. Same numbers, cleaner shape.
- **Error payload for `order/fleet_commission_above_delivery_fee`**: `data` now carries `{ platformInvoiceTotal, deliveryFee }` (was `{ platformShare, deliveryFee }`) — matches the new vocabulary.

### Removed

- **`Order.payment.platformShare`** — use `Order.payment.platformInvoice.total` (identical value, self-describing shape).
- **`Order.payment.vat.platformShare`** — same, now `Order.payment.platformInvoice.total`.
- **`Quote.platformShare` + `Quote.vat`** — use `Quote.platformInvoice.{total, vat, subtotal}`.
- **`Order.financials.amounts.platformShare` / `platformFee` / `platformFeeVat`** — use `Order.financials.amounts.platformInvoice.*`.

### Fixed

- **SDK types for reversal webhooks** (`altaer_balance.reversed`, `fleet_driver_balance.settled` / `reversed`) — `settlementId`, `originalSettlementId`, `driverId`, `orderId`, `originalOrderId` now correctly `string` (ULID). They were `number` on 0.0.32 despite the underlying server having migrated — a codegen drift closed here.
- **`RatingResponse.driverId`** — now `string` (was `number` — same drift).

## [0.0.31] — 2026-07-23

### Changed

- **`workspacePaysDelivery` is now `customerPaysDelivery`** (on `OrderCreate` and `Order`) — same semantics, clearer name: `true` (the default) puts the delivery fee on the customer's `totalAmount`; `false` means you absorb it. All docs samples updated to match.

## [0.0.30] — 2026-07-23

Unified `Order` payload + contract-exactness pass. The generated types now match the server byte-for-byte on every order surface.

### Changed

- **`orders.cancel()` resolves to the full canceled `Order`** — same shape as `orders.get()`, including the `financials` block — instead of a bare acknowledgement. The method signature already promised `Promise<Order>`; the wire now delivers it. Canceling an already-canceled order stays idempotent: `200` with the current order.
- **One `Order` shape everywhere** — create, get, list items, cancel, redispatch, and `order.*` webhook payloads all carry the same tenant view: driver snapshot (`driverId`, `driverName`, `driverPhoneNumber`, `driverImage`, `driverProfilePictureNonce`, `driverRatingAvg`, `driverRatingCount`, `currentLocation`), waypoints, payment + totals, lifecycle timestamps, `etaPickupAt` / `etaDropoffAt`, `routeDistanceMeters`, `driverOfflineSeconds`, buy-at-pickup block, `fulfilledBy`, and tracking link fields.
- **Driver-snapshot fields are explicit `null` while unassigned** (previously omitted) — bind the whole block unconditionally instead of guarding each key.
- **`RatingResponse` now includes `driverId`** (the driver the rating landed on) and matches the documented shape exactly.
- **Error `code` values on order + rating routes come from the documented catalogue** (`order/not_found`, `order/already_completed`, `order/cannot_cancel_in_state`, `order/cannot_redispatch_in_state`, `order/not_ratable`, `order/no_driver_to_rate`, `validation/invalid_format`, `validation/value_out_of_range`, …) instead of undocumented internal literals.

### Removed

- **`Order.distanceKm`** — it was never emitted. Distance lives on `Quote.distanceKm` (pre-order estimate) and `Order.routeDistanceMeters` (road-snapped actual).
- **`Outcome`'s `in_progress` member** — it was never produced; `financials` is simply absent while a delivery is in flight.

### Fixed

- **Error envelope parsing** — the client now reads the API's nested envelope (`{ error: { code, message, data? } }`), so `err.code`, `err.message`, and `err.data` carry the server's values (previously `code`/`data` came back `null` and `message` garbled). `AuthError` now surfaces the server code (`auth/api_key_invalid`), and the generated `ErrorResponse` type matches the wire shape.
- **`workspace.*` auth failures now return the documented JSON error envelope** — `getProfile` / `updateProfile` / `rotateCredentials` / `setWebhookUrl` previously answered a bad key with plain-text `Unauthorized`, which defeated typed `AuthError` parsing. The same endpoints now also enforce the per-plan rate limit (`429` / `RateLimitError`) like every other route.
- **`RatingResponse.createdAt` is always a real ISO timestamp**, matching its required non-nullable declaration. The rated driver is always derived from the order server-side — an undocumented `driverId` body override was removed.
- Docs: cancel / redispatch / rating `409` responses now name their exact error codes, `Quote.platformFeeVat` is documented as `0` (not omitted) when platform VAT is off, and `Order.isBuyAtPickup` is documented as an always-present boolean. The driver-snapshot fields and `isBuyAtPickup` are now in the schema's `required` list, so the generated `Order` type stops marking them optional.
- Docs: every `orders.create` sample includes `workspacePaysDelivery` + `isBuyAtPickup` (the generated `OrderCreate` type requires them), the webhook sample reads `event.data` inside the narrowed `switch` cases so it compiles under strict TypeScript, and the SDK-surface digest now names `finance.getSettlement` / `workspace.getProfile` / `workspace.updateProfile`.

## [0.0.28] — 2026-07-20

Documentation polish. No code / contract change.

### Changed

- **Conventions section** — split the "Money is integer minor units" and "Rates are decimals" rules into distinct bullets so each has its own bold label. `opts` sub-fields (`signal`, `idempotencyKey`, `maxRetries`) broken into a nested list. Applied consistently on both the [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api) page and the package README.
- **README's Webhook delivery rules** expanded from a paragraph to the same four-bullet list that already existed on the docs page — at-least-once semantics, retry policy, thrown-handler behaviour, and hung-handler behaviour each on its own line.

## [0.0.26] — 2026-07-20

Initial public release.

Typed TypeScript client for the [Altaer](https://altaer.app) delivery-dispatch API — create orders, stream live driver GPS, receive signed webhooks, reconcile balances. Full reference at [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api).

[0.0.33]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.33
[0.0.30]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.30
[0.0.28]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.28
[0.0.26]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.26
