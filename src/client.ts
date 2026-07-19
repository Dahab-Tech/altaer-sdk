import { HttpClient, type HttpClientConfig } from './http';
import { FinanceResource } from './operations/finance';
import { OrdersResource } from './operations/orders';
import { WorkspaceResource } from './operations/workspace';
import { TrackingResource, type TrackingConfig } from './tracking';

/** Top-level SDK client. Construct once at boot, share across handlers.
 *
 *  Configuration:
 *    apiKey       — required, your tenant's `x-api-key`
 *    baseUrl      — optional, defaults to https://altaer.app
 *    timeoutMs    — optional, default 30000ms per request
 *    maxRetries   — optional, default 3 (5xx + network only; 4xx never
 *                   retries because the body is wrong on the caller's side)
 *    fetch        — optional, BYO fetch (useful in tests or non-Node runtimes)
 *
 *  All operation methods are accessed via the namespaced resources —
 *  e.g. `client.orders.create(...)`. The flat structure lets editors
 *  surface every method with one autocomplete pass.
 */
export interface AltaerClientConfig extends HttpClientConfig {
  /** Tracking-specific config (socket URL override, lease renewal ratio).
   *  The socket is lazily opened on the first `client.tracking.subscribe(...)`
   *  call, so REST-only callers never pay the cost. */
  tracking?: TrackingConfig;
}

export class AltaerClient {
  /** Orders — create, list, get, cancel, redispatch, quote, rate. */
  readonly orders: OrdersResource;

  /** Finance reads for reconciliation — balance, summary, overview,
   *  ledger, settlements, statement. Read-only; mutating actions
   *  (request a settle, manage methods) remain hub-only by design. */
  readonly finance: FinanceResource;

  /** Your workspace's own profile + integration settings — getProfile,
   *  updateProfile, rotateCredentials, setWebhookUrl. */
  readonly workspace: WorkspaceResource;

  /** Live driver-location tracking over socket.io. Lazy — no socket is
   *  opened until the first `subscribe()`. Call `tracking.close()` on
   *  graceful shutdown to drop the connection (the SDK also auto-closes
   *  when the last subscription is removed). */
  readonly tracking: TrackingResource;

  /** Lower-level HTTP transport. Most callers won't touch this, but
   *  it's exposed so you can hit endpoints the SDK hasn't typed yet
   *  (early access, custom integrations) with the same auth + retries
   *  + idempotency-key behavior the typed methods get. */
  readonly http: HttpClient;

  constructor(config: AltaerClientConfig) {
    this.http = new HttpClient(config);
    this.orders = new OrdersResource(this.http);
    this.finance = new FinanceResource(this.http);
    this.workspace = new WorkspaceResource(this.http);
    this.tracking = new TrackingResource({
      apiKey: config.apiKey,
      baseUrl: this.http.baseUrlForTracking,
      tracking: config.tracking,
    });
  }
}
