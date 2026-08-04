// Public surface — what `import { ... } from '@dahab-tech/altaer-sdk'` resolves to.

export { AltaerClient } from './client';
export type { AltaerClientConfig } from './client';

// Webhook helpers.
export { verifyWebhook, altaerWebhookRoute } from './webhook';
export type { VerifyWebhookInput } from './webhook';

// Live tracking — types for the subscription handle + driver-location
// payloads. The resource itself is accessed via `client.tracking`.
export type {
  DriverLocationUpdate,
  OrderSubscription,
  SubscribeAck,
  SubscribeHandlers,
  TrackingConfig,
  TrackingError,
  TrackingErrorCode,
} from './tracking';

// Errors. Re-exported as classes so callers can branch with `instanceof`.
export {
  AltaerError,
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SignatureVerificationError,
  ValidationError,
} from './errors';
export type { SystemErrorCode } from './errors';

// Public types — every DTO a caller will ever need to annotate against.
export type {
  // Settlement payloads — split per flow (see WebhookEventType docs).
  AltaerBalanceSettledPayload,
  AltaerBalanceReversedPayload,
  AltaerFleetCommissionSettledPayload,
  AltaerFleetCommissionReversedPayload,
  OperatorFleetBalanceRecordedPayload,
  OriginBreakdown,
  BalanceResponse,
  CanceledBy,
  CancelOrderInput,
  CancelReasonCode,
  CreateOrderInput,
  Currency,
  DriverKycStatusChangedPayload,
  DriverLocation,
  DriverSnapshot,
  FinanceLedgerCountInput,
  FinancePaginationInput,
  FinanceReportInput,
  FinanceReportTotalsInput,
  FinanceSettlementsCountInput,
  FinanceSummary,
  FleetCreatedPayload,
  FleetDeletedPayload,
  FleetDriverAddedPayload,
  FleetDriverBalanceReversedPayload,
  FleetDriverBalanceSettledPayload,
  FleetDriverReleasedPayload,
  FleetDriverTransferredPayload,
  FleetSnapshot,
  FleetTrustGrantedPayload,
  FleetTrustRevokedPayload,
  Fulfillment,
  LedgerCountResponse,
  LedgerEntry,
  LedgerEntryType,
  LedgerListResponse,
  LedgerOrderGroup,
  LedgerOrderGroupCancellation,
  LedgerOrderGroupEconomics,
  OperatorAltaerPosition,
  OperatorWorkspacePosition,
  ListOrdersInput,
  PnlPerOrderItemsPage,
  PnlPerOrderRow,
  PnlPerOrderStatus,
  PnlPerOrderTotals,
  PnlPerOrderTotalsResponse,
  OperatingHours,
  Order,
  OrderBuyAtPickup,
  OrderCancellation,
  OrderDriver,
  OrderFinancials,
  OrderListResponse,
  OrderOutcome,
  OrderPayment,
  OrderReturn,
  OrderRoute,
  OrderStatus,
  OrderTracking,
  OrderWaypoint,
  Waypoint,
  PaymentMethod,
  Quote,
  QuoteInput,
  RateOrderInput,
  RatingResponse,
  RotateCredentialsResponse,
  SetWebhookUrlResponse,
  SimulationScenario,
  Settlement,
  SettlementCountResponse,
  SettlementDirection,
  SettlementItem,
  SettlementListResponse,
  SettlementWithItems,
  Statement,
  StatementInput,
  UpdateWorkspaceProfileInput,
  WebhookEnvelope,
  WebhookEvent,
  WebhookEventType,
  WorkspaceAltaerPosition,
  WorkspaceIndustry,
  WorkspaceProfile,
} from './types';

// HTTP transport surface — exposed for callers that need to hit an
// endpoint the typed methods haven't covered yet, while still getting
// the SDK's auth + retries + idempotency-key behavior.
export type { HttpClientConfig, RequestOptions } from './http';
