// Public API types — re-exported from the spec-derived schemas with
// friendly names. The actual shapes live in `./generated/api.ts`, which
// is produced by `openapi-typescript` from `docs/openapi/openapi.yaml`
// at build time. That makes the wire format the single source of truth
// for the SDK's type surface — they can never drift.
//
// Why a shim layer at all (vs. exporting `components['schemas']`
// directly)? Three reasons:
//   1. Friendly names: spec uses `OrderCreate`; SDK callers want
//      `CreateOrderInput`. The shim renames without forcing the spec
//      to carry SDK-specific names.
//   2. Hand-curated webhook union: the generated `WebhookEnvelopeOrder`
//      / `WebhookEnvelopeSettlement` / etc. are good, but the SDK
//      wants a single discriminated `WebhookEvent` union that narrows
//      on `type`. That assembly happens here.
//   3. Future-proofing: if we add an SDK-only convenience type that
//      isn't in the spec (e.g. a partial-update helper), it lives here.
//
// Do NOT edit `./generated/api.ts` directly — it's overwritten on every
// `npm run generate:types`. Make the spec change instead and regen.

import type { components } from './generated/api';

type Schemas = components['schemas'];

// ── Currency / money ─────────────────────────────────────────────────

export type Currency = Schemas['Currency'];

// ── Order primitives ─────────────────────────────────────────────────

export type PaymentMethod = Schemas['PaymentMethod'];
export type OrderStatus = Schemas['OrderStatus'];
export type CanceledBy = Schemas['CanceledBy'];
export type CancelReasonCode = Schemas['CancelReasonCode'];
export type Destination = Schemas['Destination'];
export type DriverLocation = NonNullable<Schemas['Order']['currentLocation']>;

// ── Requests ─────────────────────────────────────────────────────────

/** Body for `client.orders.create(input)`. Mirrors the
 *  `OrderCreate` schema in the spec. */
export type CreateOrderInput = Schemas['OrderCreate'];

/** Body for `client.orders.quote(input)`. */
export type QuoteInput = Schemas['QuoteRequest'];

/** Body for `client.orders.cancel(orderId, input?)`. All fields optional.
 *  `canceledBy` accepts `pickup` / `dropoff` / `workspace` (default) —
 *  audit-trail attribution only; `driver` / `system` are reserved and
 *  fall back to `workspace`. */
export type CancelOrderInput = Schemas['CancelOrderRequest'];

/** Body for `client.orders.rate(orderId, input)`. */
export type RateOrderInput = Schemas['RatingRequest'];

/** Optional query for `client.orders.list(input?)`. Hand-defined because
 *  query params don't get a top-level component schema in the spec —
 *  they're attached to the operation. `since` / `until` are inclusive
 *  YYYY-MM-DD bounds on `createdAt`; omit either side for unbounded. */
export interface ListOrdersInput {
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
}

// ── Finance request inputs ───────────────────────────────────────────

/** Optional query for `client.finance.overview(input?)`. */
export interface FinanceOverviewInput {
  /** ISO date `YYYY-MM-DD`. Filters to entries on or after this date.
   *  Use the start of your monthly close period for a per-month rollup. */
  since?: string;
}

/** Optional query for `client.finance.ledger(input?)` and
 *  `client.finance.settlements(input?)`. `since` / `until` are inclusive
 *  YYYY-MM-DD bounds on `createdAt`; omit either side for unbounded. */
export interface FinancePaginationInput {
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
}

/** Optional query for `client.finance.statement(input?)`. */
export interface StatementInput {
  /** ISO date `YYYY-MM-DD`. Defaults to 30 days before `toDate`. */
  fromDate?: string;
  /** ISO date `YYYY-MM-DD`. Defaults to today. */
  toDate?: string;
}

// ── Responses ────────────────────────────────────────────────────────

export type Order = Schemas['Order'];
export type Quote = Schemas['Quote'];
export type OrderListResponse = Schemas['OrderListResponse'];
export type RatingResponse = Schemas['RatingResponse'];
export type OrderFinancials = Schemas['OrderFinancials'];

// Finance responses.
export type BalanceResponse = Schemas['BalanceResponse'];
export type FinanceSummary = Schemas['FinanceSummary'];
export type FinanceOverview = Schemas['FinanceOverview'];
export type LedgerEntry = Schemas['LedgerEntry'];
export type LedgerEntryType = Schemas['LedgerEntryType'];
export type Settlement = Schemas['Settlement'];
export type SettlementDirection = Schemas['SettlementDirection'];
export type LedgerListResponse = Schemas['LedgerListResponse'];
export type SettlementListResponse = Schemas['SettlementListResponse'];
/** One line in `SettlementWithItems.items[]` — a single per-order
 *  ledger contribution that rolled into the settle. Tagged with
 *  `origin` and `type` so a consumer can filter their slice
 *  (e.g. `items.filter(i => i.origin === 'api')`). */
export type SettlementItem = Schemas['SettlementItem'];
/** Response of `client.finance.getSettlement(id)`. Contains the
 *  Settlement audit row + a flat array of per-order items that
 *  contributed to it. Used for line-by-line reconciliation when the
 *  webhook's `breakdown` totals aren't enough. */
export type SettlementWithItems = Schemas['SettlementWithItems'];
export type Statement = Schemas['Statement'];

// ── Workspace profile ────────────────────────────────────────────────

/** Response of `client.workspace.getProfile()` and `updateProfile(...)`.
 *  Sanitized — credentials never appear; `apiKeyLast4` is the only
 *  key-related field. */
export type WorkspaceProfile = Schemas['WorkspaceProfile'];
/** Body for `client.workspace.updateProfile(input)` — include only the
 *  fields you're changing. */
export type UpdateWorkspaceProfileInput = Schemas['UpdateWorkspaceProfileInput'];
export type WorkspaceIndustry = Schemas['WorkspaceIndustry'];
export type OperatingHours = Schemas['OperatingHours'];
export type WorkspacePricing = Schemas['WorkspacePricing'];
/** Response of `client.workspace.rotateCredentials()`. `apiKey` is the
 *  new key — shown once, never retrievable again. */
export type RotateCredentialsResponse = Schemas['RotateCredentialsResponse'];
/** Response of `client.workspace.setWebhookUrl(url)`. */
export type SetWebhookUrlResponse = Schemas['SetWebhookUrlResponse'];

/** Fulfilment snapshot attached to `Order.fulfilledBy` — a union
 *  discriminated on `kind`: `'platform'` (the Altaer network — no
 *  further identity is exposed) or `'fleet'` (your operator's own
 *  fleet, carries fleet id/name + ownerOperatorId). This alias gives
 *  callers a stable name to annotate against. */
export type FulfilledBy = NonNullable<Order['fulfilledBy']>;

// ── Webhook event union ──────────────────────────────────────────────

/** Every webhook event type Altaer emits. Use as the union of
 *  acceptable event names for filtering or subscription wiring.
 *
 *  Settlement events follow the pattern:
 *      workspace.<counterparty>_<balance_type>.<action>
 *
 *  where counterparty ∈ {altaer, operator}, balance_type names the
 *  underlying ledger pair, and action ∈ {settled, recorded, reversed}.
 *  Direction (in/out of the workspace's books) is on the payload's
 *  `direction` field, NOT in the event name. */
export type WebhookEventType =
  | 'order.created'
  | 'order.no_driver_found'
  | 'order.driver_assigned'
  | 'order.picked_up'
  | 'order.completed'
  | 'order.canceled'
  | 'order.failed'
  | 'order.rejected'
  // Workspace ↔ Altaer for platform delivery fees.
  | 'workspace.altaer_balance.settled'
  | 'workspace.altaer_balance.reversed'
  // Operator ↔ Altaer for fleet commission. Fans out per workspace
  // contributing to the operator's total commission settle.
  | 'workspace.altaer_fleet_commission.settled'
  | 'workspace.altaer_fleet_commission.reversed'
  // Operator ↔ workspace off-platform settle (record-only — Altaer
  // doesn't move money).
  | 'workspace.operator_fleet_balance.recorded'
  | 'fleet.created'
  | 'fleet.deleted'
  | 'fleet.driver.added'
  | 'fleet.driver.released'
  | 'fleet.driver.transferred'
  | 'fleet.trust.granted'
  | 'fleet.trust.revoked'
  | 'driver.kyc.status_changed';

/** Common envelope fields wrapping every event. The discriminator is
 *  `type`; narrow with `switch (event.type) { ... }`. */
export type WebhookEnvelope<T extends WebhookEventType, D> = Schemas['WebhookEnvelopeBase'] & {
  type: T;
  data: D;
};

// Generated allOf intersections — re-exported with predictable names.
export type FleetSnapshot = Schemas['FleetSnapshot'];
export type DriverSnapshot = Schemas['DriverSnapshot'];

// ── Altaer balance: workspace ↔ Altaer for platform delivery fees ──

/** Forward settle of the workspace's delivery balance with Altaer.
 *
 *  Single payload shape — partners read `breakdown.<origin>` for
 *  their per-origin slice. The total `amount` is the workspace-level
 *  move; `breakdown` splits it (positive = workspace owed platform
 *  for that origin; negative = platform owed workspace).
 *
 *  Replaces the prior `scope: 'api' | 'all'` discriminated union
 *  (SDK 0.0.7+). Consumers that previously narrowed on `scope` should
 *  drop the narrowing and read `breakdown` directly. */
export type AltaerBalanceSettledPayload = Schemas['AltaerBalanceSettledPayload'];

/** Reversal of a prior balance settle. Carries
 *  `originalSettlementId` for joining with the forward event, and a
 *  `breakdown` that's a verbatim copy of the original's
 *  (sign-preserved). Partners apply this with the inverse sign of
 *  how they applied the forward — forward + reversal cancel by
 *  construction. */
export type AltaerBalanceReversedPayload = Schemas['AltaerBalanceReversedPayload'];

/** Signed per-origin slice of a workspace-level money move. Same shape
 *  is reused on the settle / reversal payloads and on the audit
 *  Settlement row. */
export type OriginBreakdown = Schemas['OriginBreakdown'];

// ── Fleet commission: operator ↔ Altaer (per-workspace slice) ──────

/** One per-workspace slice of an operator's commission settle.
 *  Operators settle their total commission with one PSP charge;
 *  Altaer fans it out into N events (one per workspace contributing).
 *  All slices share `settlementId` and `providerRef`. */
export type AltaerFleetCommissionSettledPayload = Schemas['AltaerFleetCommissionSettledPayload'];

/** One per-workspace slice of a reversed commission settle. */
export type AltaerFleetCommissionReversedPayload = Schemas['AltaerFleetCommissionReversedPayload'];

// ── Operator ↔ workspace off-platform settle ──────────────────────

/** Record-only settle between operator and workspace (Altaer doesn't
 *  move money). Either side can record; `initiatedBy` distinguishes. */
export type OperatorFleetBalanceRecordedPayload = Schemas['OperatorFleetBalanceRecordedPayload'];

// Fleet / driver / KYC payloads — extracted from their respective
// envelopes' `data` shape so partners can annotate variables against
// the same types the SDK passes to their handlers.
export type FleetCreatedPayload = Schemas['WebhookEnvelopeFleetCreated']['data'];
export type FleetDeletedPayload = Schemas['WebhookEnvelopeFleetDeleted']['data'];
export type FleetDriverAddedPayload = Schemas['WebhookEnvelopeFleetDriverAdded']['data'];
export type FleetDriverReleasedPayload = Schemas['WebhookEnvelopeFleetDriverReleased']['data'];
export type FleetDriverTransferredPayload =
  Schemas['WebhookEnvelopeFleetDriverTransferred']['data'];
export type FleetTrustGrantedPayload = Schemas['WebhookEnvelopeFleetTrustGranted']['data'];
export type FleetTrustRevokedPayload = Schemas['WebhookEnvelopeFleetTrustRevoked']['data'];
export type DriverKycStatusChangedPayload = Schemas['WebhookEnvelopeDriverKyc']['data'];

/** Discriminated union of every webhook event. Narrow with `event.type`:
 *
 *    switch (event.type) {
 *      case 'order.completed':
 *        event.data.financials!.deliveryFee; // ← typed
 *        break;
 *      case 'workspace.altaer_balance.settled':
 *        event.data.breakdown.api; // ← your per-origin slice
 *        break;
 *    }
 */
export type WebhookEvent =
  | WebhookEnvelope<'order.created', Order>
  | WebhookEnvelope<'order.no_driver_found', Order>
  | WebhookEnvelope<'order.driver_assigned', Order>
  | WebhookEnvelope<'order.picked_up', Order>
  | WebhookEnvelope<'order.completed', Order>
  | WebhookEnvelope<'order.canceled', Order>
  | WebhookEnvelope<'order.failed', Order>
  | WebhookEnvelope<'order.rejected', Order>
  | WebhookEnvelope<'workspace.altaer_balance.settled', AltaerBalanceSettledPayload>
  | WebhookEnvelope<'workspace.altaer_balance.reversed', AltaerBalanceReversedPayload>
  | WebhookEnvelope<
      'workspace.altaer_fleet_commission.settled',
      AltaerFleetCommissionSettledPayload
    >
  | WebhookEnvelope<
      'workspace.altaer_fleet_commission.reversed',
      AltaerFleetCommissionReversedPayload
    >
  | WebhookEnvelope<
      'workspace.operator_fleet_balance.recorded',
      OperatorFleetBalanceRecordedPayload
    >
  | WebhookEnvelope<'fleet.created', FleetCreatedPayload>
  | WebhookEnvelope<'fleet.deleted', FleetDeletedPayload>
  | WebhookEnvelope<'fleet.driver.added', FleetDriverAddedPayload>
  | WebhookEnvelope<'fleet.driver.released', FleetDriverReleasedPayload>
  | WebhookEnvelope<'fleet.driver.transferred', FleetDriverTransferredPayload>
  | WebhookEnvelope<'fleet.trust.granted', FleetTrustGrantedPayload>
  | WebhookEnvelope<'fleet.trust.revoked', FleetTrustRevokedPayload>
  | WebhookEnvelope<'driver.kyc.status_changed', DriverKycStatusChangedPayload>;
