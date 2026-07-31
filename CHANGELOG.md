# Changelog

All notable changes to `@dahab-tech/altaer-sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.40] — 2026-07-31

Ledger-vocabulary unification: every finance surface now speaks the same flat entry types, and the type docs state the correct money direction.

### Changed

- **`LedgerEntryType` value renamed: `op_workspace` → `operator_workspace`.** Same rows, clearer name for the operator↔workspace accrual. If you matched the old string, update the branch — the API never emits `op_workspace` again.
- **`SettlementItem.type` now speaks the flat ledger vocabulary** — enum is `cash_due | card_payable | punitive | operator_workspace` (was the raw stored types `order_completion | order_cancel_punitive | operator_workspace_payment`). Settlement items now join directly against `/finance/ledger` rows on `type` with no translation table.

### Docs / spec corrections (no wire changes — the API always behaved this way)

- **`cash_due` / `card_payable` descriptions had the money direction backwards.** They are payment-family tags, not directions — direction lives in `amount.direction`. Corrected semantics: `cash_due` on a completed order is a **credit** (the driver collected the full COD, Altaer owes your workspace the merchant slice; flips to debit on cancel-after-pickup / door-refusal shortfall); `card_payable` is always a **debit** (you hold the prepaid revenue and owe the delivery invoice).
- `FinanceSummary.cashDue` / `cardPayable` documented as signed sums with the same corrected orientation; `owedOrdersCount` counts `cash_due`/`card_payable` rows (one per order leg), not "completions".

## [0.0.39] — 2026-07-30

Spec-accuracy release: the OpenAPI document (and the types generated from it) now match the deployed API exactly. One behavior fix in the error layer.

### Fixed

- **`RateLimitError.code` now carries the server's envelope code** (`auth/rate_limit_exceeded`) instead of the hardcoded literal `'rate_limited'`. Every error class now honors the same `.code` contract: "machine-readable code from the server's error envelope". If you branched on `err.code === 'rate_limited'`, branch on `instanceof RateLimitError` (always correct) or the new code string.
- **`SettlementItem.type`** — the generated enum previously listed `settlement`, which the API never emits as an item (settle rows are excluded from item lists by construction). The real third value is `operator_workspace_payment` (own-fleet operator↔workspace goods/fee leg).

### Docs / spec corrections (no wire changes — the API always behaved this way)

- Id fields are documented as `format: altaer-id` (prefixed strings like `ord_h7Q2mX41Zp`) — the previous `format: ulid` tag and bare-integer id examples were wrong.
- `Idempotency-Key` accepts any string (not just UUIDs), and only **2xx** responses are cached — a failed attempt retried with the same key re-executes.
- `PUT /workspaces/me/webhook` — `webhookUrl` is optional: null, empty string, or omitting the field clears the webhook.
- Statement `fromDate` / `toDate` accept full ISO date-times for sub-day precision, not just `YYYY-MM-DD`.
- Validation bounds documented: waypoint string caps (contactName 120, phone 4–30, address 500, …), quote coordinate ranges (±90 / ±180), `cancelReason` 500, rating `comment` 2000.
- Rate limiting: bucketed per workspace per minute (not per-IP); every response carries `RateLimit-Limit` / `RateLimit-Remaining`.
- Sandbox webhook deliveries dead-letter after 2 attempts (production: 12).
- Sandbox simulation docs cover `customer_refused_return` (requires `returnable: true`; excluded from `random`), and the SDK digest lists `orders.createReturn`.

## [0.0.38] — 2026-07-29

Three additive updates on the finance surface. `GET /statement` paginates its `entries` array (window totals stay on every page). `LedgerEntryType` gains four values that were emitted by the API for own-fleet workspaces but missing from the documented enum. The `/ledger` reader now trusts the writer's workspace-attribution stamps so its output matches the `workspace.*` webhook fan-out (own-fleet workspaces now receive their operator-commission and fleet-driver rows here — previously only via webhook).

### Added

- **`StatementInput.limit` / `StatementInput.offset`** — page controls for `al.finance.statement()`. Defaults match every other finance list: `limit=50`, max `200`, `offset=0`.
- **`Statement.total` / `Statement.limit` / `Statement.offset`** — window-scoped row count + echoed page params on every response.
- **`LedgerEntryType` gains four values** (all previously undocumented but emitted for own-fleet workspaces):

  - `punitive` — driver-cancel-after-pickup rows. Recovery leg that makes your workspace whole for the merchant slice the driver walked off with; sign is `credit`.
  - `op_workspace` — accrual between your workspace and its fulfilling operator on own-fleet direct-routing (cash COD → operator owes you goods; card prepay → you owe operator delivery fee).
  - `fleet_commission` — commission your fleet paid Altaer per order. Mirrors the `workspace.altaer_fleet_commission.*` webhook.
  - `fleet_driver_payment` — cash-COD / payout leg between your operator and one of their fleet drivers. Mirrors the `workspace.fleet_driver_balance.settled` webhook.

  All four appear only for hub-internal own-fleet workspaces (workspaces served by their own operator's fleet). External tenants using trusted-network fleets never see them — the writer applies symmetric obscurity so the underlying rows aren't attributed to the workspace at write time, and the reader honors that.

### Behavior

- `Statement.entries` is now a page slice (default 50 rows). `openingBalance`, `closingBalance`, `total`, and `summary` are **window-scoped** — identical on every page in the same window. Walk pages by bumping `offset` until you've consumed `total` rows.
- `Statement.summary` is now computed server-side in a single Mongo aggregation instead of walking every entry in JS — meaningful only if you were noticing latency on large windows.
- **`al.finance.ledger()` now surfaces own-fleet operator + fleet-driver rows** for hub-internal workspaces. Previously those rows only reached those workspaces via webhook events (`workspace.altaer_fleet_commission.*`, `workspace.fleet_driver_balance.settled`); the SDK poll path was missing them. Now the read matches the webhook fan-out — same set of rows, same attribution. Trusted-fleet cross-operator legs remain hidden as before.

### Migration

No breaking changes for the wire shape. Existing code keeps working. Two considerations:

**Wide-window statement callers** — if you assumed `entries` contained every row, either narrow the window or walk pages:

```ts
// before (0.0.37) — got every row in one response
const s = await al.finance.statement({
  fromDate: '2026-01-01',
  toDate: '2026-06-30',
});
for (const row of s.entries) {
  /* ... */
}

// after (0.0.38) — walk pages
let offset = 0;
const pageSize = 200;
while (true) {
  const page = await al.finance.statement({
    fromDate: '2026-01-01',
    toDate: '2026-06-30',
    limit: pageSize,
    offset,
  });
  for (const row of page.entries) {
    /* ... */
  }
  offset += page.entries.length;
  if (offset >= page.total) break;
}
```

**Exhaustive `LedgerEntryType` switches** — add cases for the four new values (or a `default` that logs unknowns). TypeScript will flag missing arms after upgrading. Pure-tenant integrations that only ever see `cash_due` / `card_payable` / `settlement` / `adjustment` don't need changes — the new values only appear for hub-internal own-fleet workspaces.

## [0.0.37] — 2026-07-27

Adds a per-workspace hourly cap on `POST /orders`, distinct from the existing per-minute API rate limit. Protects the driver pool from an authenticated tenant flooding fake dispatches by burning the general API budget entirely on order creates.

### Added

- **`WorkspacePlanBlock.orderCreatesPerHour`** — nullable integer. Hourly ceiling on `POST /orders` per tenant. Null means the platform default for the tenant's plan applies (`starter` 30/hr, `growth` 2 000/hr, `scale` 20 000/hr, `custom` 2 000/hr). Reads via `al.workspace.getProfile()` (in `plan.orderCreatesPerHour`); writes via the same admin `PUT /me/plan` endpoint that sets the other ceilings.

### Behavior

- Exceeding the cap on `POST /orders` returns `429` with error code `auth/rate_limit_exceeded` (same shape / handling as the existing per-minute limit — `RateLimitError` in the SDK, `retryAfterSec` populated from the `Retry-After` header).
- The two limiters are independent: read-heavy tenants no longer consume their order-creation budget on GETs.

### Migration

No client code changes required for existing integrations. If you were parsing `plan` and expecting exactly three fields, expect a fourth (`orderCreatesPerHour`) on every response.

## [0.0.35] — 2026-07-26

`WorkspaceProfileBlock.businessAddress` renamed to `branchAddress`. The field semantically was always the per-branch operating address (pickup location, service area, delivery receipt); the old name suggested "the business's legal address" which is a different concept — legal / tax address lives on the operator, not the workspace. Server 400s on the old key (no compat alias), so this is a required update.

### Changed

- **`WorkspaceProfile.profile.businessAddress` → `WorkspaceProfile.profile.branchAddress`**. Same type (`string | null`), same semantics as before (per-branch operating location).
- **`UpdateWorkspaceProfileInput.branchAddress`** replaces the old `businessAddress` key on the PATCH body. Old key returns `400 Unknown field(s): businessAddress`.

### Migration

```ts
// before (0.0.34)
const profile = await al.workspace.getProfile();
console.log(profile.profile.businessAddress);
await al.workspace.updateProfile({ businessAddress: '12 El-Tahrir St, Cairo' });

// after (0.0.35)
const profile = await al.workspace.getProfile();
console.log(profile.profile.branchAddress);
await al.workspace.updateProfile({ branchAddress: '12 El-Tahrir St, Cairo' });
```

## [0.0.34] — 2026-07-25

`WorkspaceProfile` restructured into named blocks. Reading `w.tradeName` becomes `w.profile.tradeName`; reading `w.apiKeyLast4` becomes `w.dev.keyLast4`; reading `w.rateLimitPerMin` becomes `w.plan.rateLimitPerMin`. The block names are self-documenting so integrations know at a glance what each field family covers.

### Changed

- **`WorkspaceProfile` is now grouped into three blocks**:
  - **`profile`** — business identity: `tradeName`, `businessAddress`, `industry`, `logoUrl`, `operatingHours`.
  - **`dev`** — developer/integration surface: `keyLast4`, `hasKey` (derived), `webhookUrl`, `hasWebhookSecret` (derived).
  - **`plan`** — subscription: `key`, `rateLimitPerMin`, `maxTrackedOrders`.
- **`UpdateWorkspaceProfileInput` accepts the same grouped shape** (send `{ profile: { tradeName: '...' } }` instead of `{ tradeName: '...' }`).
- `hasKey` / `hasWebhookSecret` on `dev` are booleans derived server-side from whether credentials are configured — you never see the hash, only a "yes/no" signal for whether a value is set.

### Removed

- **`WorkspaceProfile.pricing` + the `WorkspacePricing` schema** — the field never had an editor and was always `null` in practice. Delivery pricing resolution is `fleet-custom formula > pickup-zone > per-currency default`; there was no per-workspace tier.
- Flat top-level fields on `WorkspaceProfile`: `tradeName`, `businessAddress`, `industry`, `logoUrl`, `operatingHours`, `apiKeyLast4`, `webhookUrl`, `plan` (as string), `rateLimitPerMin`, `maxTrackedOrders`. Every one moved into `profile` / `dev` / `plan`.

### Migration

```ts
// before (0.0.33)
const profile = await al.workspace.getProfile();
console.log(profile.tradeName, profile.apiKeyLast4, profile.rateLimitPerMin);
await al.workspace.updateProfile({ tradeName: 'New Name' });

// after (0.0.34)
const profile = await al.workspace.getProfile();
console.log(
  profile.profile.tradeName,
  profile.dev.keyLast4,
  profile.plan.rateLimitPerMin
);
await al.workspace.updateProfile({ profile: { tradeName: 'New Name' } });
```

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

[0.0.34]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.34
[0.0.33]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.33
[0.0.30]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.30
[0.0.28]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.28
[0.0.26]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.26
