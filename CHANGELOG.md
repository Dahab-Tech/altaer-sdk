# Changelog

All notable changes to `@dahab-tech/altaer-sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.50] — 2026-08-08

Rename: the workspace-cancel outcome segment in `LedgerEntryType` is now `workspace_canceled_post_pickup` (was `workspace_canceled_post_dispatch`). Semantics are unchanged — these legs only ever fire when the workspace cancels after pickup (pre-pickup cancels write no ledger rows); the name now states the real gate and matches the order-level `workspace_cancel_post_pickup` outcome.

### Breaking

- **`LedgerEntryType`: `workspace_canceled_post_dispatch` → `workspace_canceled_post_pickup`** in all seven values: `own_fleet.workspace_canceled_post_pickup.workspace_to_operator` / `.operator_to_driver` / `.platform_commission`, `network_user.workspace_canceled_post_pickup.workspace_to_platform`, `network_operator.workspace_canceled_post_pickup.platform_to_operator` / `.operator_to_driver` / `.platform_commission`. Update string literals and exhaustive `switch` arms — no behavioral change.
- **P&L `status` value on `GET /finance/reports/pnl-per-order` (+ `/totals`)** renamed the same way: `workspace_canceled_post_dispatch` → `workspace_canceled_post_pickup`.

### Fixed

- Cash workspace-cancel on Altaer-network routing: the `workspace_to_platform` / `platform_to_operator` clearing legs now carry the full delivery invoice (`subtotal + VAT`). They previously booked the ex-VAT fee, so ledger entries and the workspace ↔ Altaer balance understated the obligation by the invoice VAT.

## [0.0.48] — 2026-08-06

Cash punitive on return orders — where the driver already collected door-cash before absconding — now claws that cash back to the workspace alongside the goods recovery. Adds five ledger types to `LedgerEntryType` (all under `driver_abandoned_post_pickup`).

### Added

- `own_fleet.driver_abandoned_post_pickup.driver_cash_to_operator` + `operator_cash_to_workspace` (direct routing), and `network_operator.driver_abandoned_post_pickup.driver_cash_to_operator` + `operator_cash_to_platform` + `network_user.driver_abandoned_post_pickup.platform_cash_to_workspace` (via_platform routing) — restitution legs that self-skip at amount 0 on ordinary punitive rows (owed-time re-stamp sets `totalAmount = 0`) and carry the door-collected cash on cash-return rows.

### Changed

- **`payment.totalAmount` on cash terminal rows is now the amount actually collected on that row.** Ordinary cash punitive / workspace-cancel rows read `0` (nothing collected pre-dropoff); cash `customer_refused` originals and cash return rows carry the door-collected slice. Card totals unchanged.
- **`GET /finance/reports/pnl-per-order`**: `incomeMinor = goodsMinor + customerPaidMinor` on every row (previously punitive rows returned recovery in `incomeMinor` with `goodsMinor = 0`). `goodsMinor` now carries the goods-recovery on `driver_abandoned_post_pickup`; `customerPaidMinor` is populated on every cash row (not just `completed` / `customer_refused`) — cash punitive on ordinary rows still reads `0` there via the re-stamp.

## [0.0.47] — 2026-08-06

Per-order P&L switches to the real-cash convention: rows surface what the end customer actually paid for delivery, and door-refused orders get their own status.

### Changed

- **`incomeMinor` on `GET /finance/reports/pnl-per-order` (+ `/totals`) now includes the customer-paid delivery slice.** On `completed` / `customer_refused` rows, income = merchant slice + `customerPaidMinor`, so `netMinor` reflects the workspace's real out-of-pocket — a customer-funded delivery nets to the goods amount instead of booking the delivery bill as a loss.

### Added

- `customerPaidMinor` on P&L rows and window totals — `max(0, totalAmount − merchantAmount)`, the delivery slice the customer actually paid on the row. `0` on statuses whose `totalAmount` is not customer-collected money (`workspace_canceled_post_dispatch`, `driver_abandoned_post_pickup`).
- P&L `status` value `customer_refused` — door-refused originals were previously reported as `workspace_canceled_post_dispatch`.

## [0.0.46] - 2026-08-05

New shapes

### Breaking

## [0.0.45] — 2026-08-05

`/finance/settlements` now matches the items/count split already in place for `/finance/ledger`, and per-order P&L is exposed to tenants for the first time (previously hub-only).

### Breaking

- **`GET /api/v1/workspaces/me/finance/settlements` no longer returns `total`.** The response is `{ items, limit, offset }` — the count moved to a new sibling endpoint so page flips within the same window stop repaying the count aggregation.

  Migration:

  ```ts
  // Before (0.0.44):
  const page = await al.finance.settlements({ since, until });
  console.log(`showing ${page.items.length} of ${page.total}`);

  // After (0.0.45):
  const [page, { total }] = await Promise.all([
    al.finance.settlements({ since, until }),
    al.finance.settlementsCount({ since, until }), // cache per window
  ]);
  console.log(`showing ${page.items.length} of ${total}`);
  ```

  `settlementsCount` is cheap; cache it against the `(since, until)` pair and refetch only when the window changes.

### Added

- **`GET /api/v1/workspaces/me/finance/settlements/count` → `{ total }`.** Sibling of `/settlements`, mirroring the existing `/finance/ledger/count` pattern. Exposed as `al.finance.settlementsCount({ since?, until? })`.
- **`GET /api/v1/workspaces/me/finance/reports/pnl-per-order` → `{ items, limit, offset }`.** Per-order P&L report for the workspace — one row per completed/canceled order in the window, workspace-perspective (`incomeMinor` = merchant slice + punitive recoveries, `costMinor` = delivery fee + priced VAT, `netMinor` = income − cost). Order-driven pagination — same-order legs never split across pages. Exposed as `al.finance.report({ since?, until?, limit?, offset? })`. Previously hub-only.
- **`GET /api/v1/workspaces/me/finance/reports/pnl-per-order/totals` → `{ since, until, totals, total }`.** Per-currency whole-window sums (same-named fields as the row) + order count. Cache per window. Exposed as `al.finance.reportTotals({ since?, until? })`.
- **`SettlementCountResponse`, `PnlPerOrderRow`, `PnlPerOrderStatus`, `PnlPerOrderItemsPage`, `PnlPerOrderTotals`, `PnlPerOrderTotalsResponse`** exported as SDK types.
- **`FinanceSettlementsCountInput`, `FinanceReportInput`, `FinanceReportTotalsInput`** input types.

## [0.0.44] — 2026-08-05

Wire-shape reshuffles across `/finance/ledger` and `Settlement.provider`. No math changes vs 0.0.43 — same numbers, cleaner shapes. Three breaking response-shape changes, all bundled here so consumers do one migration instead of three.

### Breaking

- **`LedgerOrderGroup.entries[]` items shrunk to `{ id, type, amount }`.** Order-facts previously repeated on every entry are hoisted to the parent group so the wire stops duplicating them across every leg of a multi-leg order. New group fields:

  - `writtenAt` (`string`) — ledger batch write time (differs from `createdAt` for post-completion writes; a completed order's `createdAt` is when it was placed, `writtenAt` is when the ledger legs were finalized).
  - `currency` (`Currency`) — every leg of an order shares one currency (single-currency-per-batch invariant).
  - `economics` (`LedgerOrderGroupEconomics`) — `{ deliveryFee, prepaidAmount, orderTotalAmount, platformFeeVat, platformCommissionAmount, platformCommissionRate }`. Snapshot at ledger-write time, same across every leg.
  - `cancellation` (`LedgerOrderGroupCancellation | null`) — `{ canceledBy, statusBeforeCancel }` on canceled orders; `null` on completed.

  Removed from `LedgerEntry` (read from the parent group instead): `currency`, `orderId`, `externalOrderId`, `deliveryFee`, `prepaidAmount`, `orderTotalAmount`, `platformFeeVat`, `canceledBy`, `statusBeforeCancel`, `note`, `createdAt`.

  Migration:

  ```ts
  // Before (0.0.43):
  for (const group of page.items) {
    for (const row of group.entries) {
      console.log(row.currency, row.deliveryFee, row.orderId);
    }
  }
  // After (0.0.44):
  for (const group of page.items) {
    console.log(group.currency, group.economics.deliveryFee, group.orderId);
    for (const row of group.entries) {
      console.log(row.type, row.amount);
    }
  }
  ```

- **`amount.direction` enum renamed `debit` | `credit` → `in` | `out`.** Workspace POV: `out` = money going out of your balance (an obligation-adding event — you owe more, or you paid); `in` = money coming into your balance (an obligation-reducing event — you were paid, or a debt was cleared). Semantic mapping is exact: old `debit` → new `out`, old `credit` → new `in`. No math changes; just a clearer name.

  Migration:

  ```ts
  // Before:
  const signed =
    row.amount.direction === 'debit' ? row.amount.value : -row.amount.value;
  // After:
  const signed =
    row.amount.direction === 'out' ? row.amount.value : -row.amount.value;
  ```

- **`Settlement.provider` gained `psp` field; `method` values simplified.** The provider block now discriminates PSP explicitly instead of encoding it into a composite label:

  ```ts
  // Before (0.0.43):
  provider: { method: 'stripe_checkout',  ref: 'cs_...' }
  provider: { method: 'paymob_checkout',  ref: '12345'  }
  provider: { method: 'psp',              ref: 'pi_...' }  // saved-card MIT
  provider: { method: 'manual_cash',      ref: null      }

  // After (0.0.44):
  provider: { psp: 'stripe', method: 'checkout', ref: 'cs_...' }
  provider: { psp: 'paymob', method: 'checkout', ref: '12345' }
  provider: { psp: 'stripe', method: 'card',     ref: 'pi_...' }
  provider: { psp: null,     method: 'manual_cash', ref: null }
  ```

  `psp: 'stripe' | 'paymob' | null` says which processor moved the money (null for off-platform rails like manual cash); `method` is the semantic channel (`checkout`, `card`, `disburse`, `manual_cash`, `instapay`, `vodafone_cash`, `fawry_pay`, …). Refund tooling and per-PSP reconciliation now route on `provider.psp` — no label parsing.

  Migration:

  ```ts
  // Before:
  if (
    s.provider.method === 'stripe_checkout' ||
    s.provider.method === 'stripe_card'
  ) {
    /* stripe */
  }
  // After:
  if (s.provider.psp === 'stripe') {
    /* stripe */
  }
  ```

### Added

- **`LedgerOrderGroupEconomics`, `LedgerOrderGroupCancellation`** exported as SDK types for consumers that want to type the new group fields explicitly.

## [0.0.43] — 2026-08-04

Balance envelope correctness + performance. Response shape unchanged from 0.0.42 — this release fixes several correctness bugs in the balance math and dramatically speeds up the endpoint. Consumers seeing surprising Card A `net` numbers or an inflated Card B `operatorAltaer.net` should see corrected values without any code change.

### Fixed

- **`workspaceAltaer.net` sign math**: 0.0.42 computed net by subtracting SIGNED sums (`deliveryOwedToAltaer − merchantHeldByAltaer`) but the two fields were themselves signed (the "held" side is a credit / negative), so `net` came out inflated (subtracting a negative). Now composed from magnitudes: `|delivery| − |held|`. Example: workspace with $100 held by Altaer + $30 owed to Altaer → 0.0.42 returned `net: 130`, now returns `net: -70` (Altaer owes you $70). Matches the sign convention docs promised.
- **`workspaceAltaer.merchantHeldByAltaer` + `deliveryOwedToAltaer`**: now truly magnitudes (≥ 0) as documented. 0.0.42 returned signed sums, so `merchantHeldByAltaer` came out negative — inconsistent with the "magnitude Altaer is holding" description.
- **`workspaceAltaer` magnitudes now offset by settlements**: 0.0.42's reader excluded `settlement` / `settlement_reversal` rows entirely, so the two magnitude fields showed LIFETIME accruals instead of CURRENT unsettled state. A workspace that had accrued $100 in merchant and settled all of it still saw `merchantHeldByAltaer: 100`. Fixed to include settle rows and bucket them by ledger direction (`paid_to` release → merchant side, `collected_from` release → delivery side). Fully-settled workspaces now correctly report zeros. `unsettledOrdersCount` also switched from row-count (double-counted trusted-network orders that write two Card A legs) to distinct-order count.
- **`workspaceAltaer` for own-fleet-only tenants**: was pulling in own-fleet operator↔workspace legs (which belong on Card C), producing enormous inflated numbers. Now scoped strictly to `network_user.*` platform-touching legs.
- **`operatorAltaer.net` semantics**: now WORKSPACE-SCOPED (this workspace's commission slice only) instead of operator-aggregate. Works correctly because the settle writer already stamps `workspaceId` on each per-workspace settle slice — filtering by `workspaceId` gives you `accruals − attributed settlements`. For single-workspace operators this is identical to operator-total; for multi-workspace operators, each workspace sees only its own slice.
- **`operatorWorkspace.net` now offset by off-platform settles**: same class of bug as `workspaceAltaer` above — the Card C reader excluded `settlement` / `settlement_reversal` rows, so off-platform settles never reduced the net. A workspace that accrued a $367 tab with its operator and settled it off-platform still saw `operatorWorkspace.net: -367`. Fixed to include settle rows with a workspace↔operator account-pair guard (so Card A/B settle rows with the same `workspaceId` stamp don't leak in).
- **`/finance/ledger` order groups return the legs THIS tenant is a party to**: previously (pre-0.0.43) the per-order `entries` array returned all 4 legs on trusted-network orders (workspace↔platform + a stranger operator↔platform internal clearing) because they all share the same `workspaceId` snapshot. Now filtered by account-touching:
  - **Trusted-network tenants** (using the Altaer network) see only their workspace↔platform legs (1 leg per order) — the operator's internal clearing legs are correctly hidden (that operator is a stranger to you).
  - **Own-fleet tenants** (running their own fleet — you ARE the operator) see all 3 legs of a direct-routing order: workspace↔operator, driver↔operator, operator→platform commission. Post-fix: mid-refactor a too-narrow filter was hiding the driver + commission legs on own-fleet orders, showing only 1 of 3. Corrected in the same release.

### Performance

- **`/finance/balance`** typical latency dropped ~50% (measured on production workloads: 800ms → 400ms). Added a compound `(workspaceId, type)` index on ledger entries and rewrote the three composer readers to be type-anchored — Mongo now jumps directly to the relevant type-subset instead of scanning every workspace row. Trusted-user tenants with no commission activity see near-instant returns for Card B/C (zero matching rows via index probe).

### Notes

- Balance envelope shape is unchanged from 0.0.42 — the correctness fixes above land without any code change on the balance consumers.
- Ledger shape reshuffle is the only breaking wire change in 0.0.43; regenerate types (`openapi-typescript`) and follow the two migrations above.

## [0.0.42] — 2026-08-04

Tenant finance API reshape. Two independent changes that ship together:

1. **`/balance`** now returns a **workspace-scoped, single-currency, three-slice envelope**. Currency lives at the envelope root; every slice below shares it. Slice values are workspace-scoped — never operator-aggregated across all workspaces the operator serves.
2. **`/ledger`** now paginates per order (one item per order, each carrying its ledger legs) instead of per entry.

### Breaking

- **`client.finance.summary()` removed.** The lifetime summary shape is still available inside `Statement.summary` from `client.finance.statement(...)`.
- **`client.finance.overview()` removed.** The dashboard-oriented KPI rollup wasn't in the tenant contract's spirit; reconciliation numbers live on the new `BalanceResponse` envelope and per-window totals live on `Statement`.
- **`FinanceOverview` + `FinanceOverviewInput` type exports removed.**
- **`BalanceResponse` shape changed.** Was `{ balance: number }`; is now the envelope:
  ```ts
  {
    currency: 'EGP' | 'USD' | 'EUR' | 'GBP';    // root — single-currency by design
    workspaceAltaer: { net, merchantHeldByAltaer, deliveryOwedToAltaer, unsettledOrdersCount } | null;
    operatorAltaer: { net } | null;              // operator's commission balance vs Altaer, in this workspace's currency
    operatorWorkspace: { net } | null;           // singular — workspace vs its operator, off-platform
    asOf: string;                                // ISO stamp for socket race resolution
  }
  ```
  Sign convention on every `.net`: **positive = YOU owe them, negative = they owe YOU** — same across all three slices. Each slice is nullable so the body shape stays stable — non-null presence tells you which cards apply. `operatorAltaer` / `operatorWorkspace` are non-null only when you operate a fleet.
- **`LedgerListResponse` shape changed.** Was `{ items: LedgerEntry[], total, limit, offset }`; is now `{ items: LedgerOrderGroup[], limit, offset }` where each group is `{ orderId, externalOrderId, createdAt, entries: LedgerEntry[] }`. **Pagination unit is now orders, not entries** — pages never split same-order legs. Settlements + adjustments no longer appear in this stream; use `client.finance.settlements(...)` for them.
- **`total` removed from the ledger items response.** Fetch it from the new sibling endpoint (see below).

### Added

- **`client.finance.ledgerCount(input?)` → `{ total }`** — total-order-count sibling for the ledger paginator. Cache per window (`since`/`until`) and refetch only when the window changes, not on every page flip.
- **New types**: `WorkspaceAltaerPosition`, `OperatorAltaerPosition`, `OperatorWorkspacePosition`, `LedgerOrderGroup`, `LedgerCountResponse`, `FinanceLedgerCountInput`.

### Fixed

- **`workspaceAltaer.net` no longer double-counts own-fleet operator↔workspace legs** into the Altaer position. Pre-refactor the field summed every workspace-touching ledger leg (including own-fleet direct-routing legs that belong on the operator slice); now it's composed from `deliveryOwedToAltaer − merchantHeldByAltaer` (Altaer-touching legs only). Own-fleet-only tenants with no Altaer exposure correctly get `workspaceAltaer: null`.
- **`/balance` latency**: pre-refactor the two operator slices ran unbounded operator-wide aggregations. Now every read is workspace-scoped (indexed on `workspaceId`), typically <100ms.

### Migration

```ts
// Balance
- const { balance } = await al.finance.balance();
- if (balance > 0) console.log('you owe', balance);
+ const b = await al.finance.balance();
+ console.log('currency:', b.currency);
+ if (b.workspaceAltaer && b.workspaceAltaer.net > 0) {
+   console.log('you owe Altaer:', b.workspaceAltaer.net);
+ }
+ if (b.operatorAltaer) console.log('commission owed:', b.operatorAltaer.net);
+ if (b.operatorWorkspace) console.log('vs operator:', b.operatorWorkspace.net);

// Ledger — group iteration
- const page = await al.finance.ledger({ limit: 50 });
- for (const row of page.items) console.log(row.type, row.amount);
+ const page = await al.finance.ledger({ limit: 20 });
+ for (const group of page.items) {
+   for (const row of group.entries) console.log(row.type, row.amount);
+ }
+ const { total } = await al.finance.ledgerCount(); // was page.total

// Summary — now embedded in Statement
- const s = await al.finance.summary();
+ const { summary } = await al.finance.statement();
```

## [0.0.41] — 2026-08-02

Ledger-type vocabulary overhaul. Every entry type is now a self-describing three-segment name `<scope>.<outcome>.<direction>` (e.g. `own_fleet.completed.operator_to_workspace`, `network_user.workspace_canceled_post_dispatch.workspace_to_platform`). The old flat vocabulary (`cash_due`, `card_payable`, `punitive`, `operator_workspace`, `fleet_commission`, `fleet_driver_payment`) is gone.

### Breaking

- **`LedgerEntryType` enum rewritten** — 36 new names, no overlap with the old vocabulary. Exhaustive `switch` statements need to be regenerated. Scopes: `own_fleet` (own-operator direct), `network_operator` (trusted-fleet operator serving the network), `network_user` (workspace using the Altaer network — the scope external tenants almost always see). Outcomes: `completed`, `workspace_canceled_post_dispatch`, `driver_abandoned_post_pickup`, `customer_refused`. Direction: `<fromParty>_to_<toParty>` or `platform_commission` (always operator → platform). Universals: `settlement`, `settlement_reversal`, `adjustment`.
- **`settlement_reversal` split out from `settlement`.** Failed-payout undo rows carry their own type + `reversalOf` snapshot instead of appearing as another `settlement` with an obligation-reversal sign. Consumers reconciling settle history need to fold both into their "settlement" bucket.
- **`FinanceSummary` field renames** (still available inside `Statement.summary`):
  - `cashDue` → `merchantHeldByAltaer`
  - `cardPayable` → `deliveryOwedToAltaer`
  - `owedOrdersCount` → `unsettledOrdersCount`

### Migration

```ts
- if (row.type === 'cash_due') ...
- if (row.type === 'card_payable') ...
- if (row.type === 'operator_workspace') ...
+ // Filter by suffix segment for the common cases:
+ if (row.type.endsWith('.platform_commission')) ...     // commission legs
+ if (row.type.endsWith('.workspace_to_platform')) ...   // you owe Altaer
+ if (row.type.endsWith('.platform_to_workspace')) ...   // Altaer owes you
+ // Or match a full scope+outcome+direction name from the enum.
```

Full type list + writing spec: `docs/ledger-scenarios.md` in the repo.

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
