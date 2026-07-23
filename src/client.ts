import { HttpClient, type HttpClientConfig } from './http';
import { FinanceResource } from './operations/finance';
import { OrdersResource } from './operations/orders';
import { WorkspaceResource } from './operations/workspace';
import { TrackingResource, type TrackingConfig } from './tracking';

/** Top-level SDK client. Construct once at boot, share across handlers.
 *  Options: apiKey (required), baseUrl, timeoutMs (30s), maxRetries (3, 5xx+network only),
 *  fetch (BYO for tests/non-Node runtimes). Operations via namespaced resources:
 *  client.orders, client.finance, client.workspace, client.tracking. */
export interface AltaerClientConfig extends HttpClientConfig {
  /** Tracking-specific config (socket URL override, lease renewal ratio).
   *  The socket is lazily opened on the first `client.tracking.subscribe(...)`
   *  call, so REST-only callers never pay the cost. */
  tracking?: TrackingConfig;
}

export class AltaerClient {
  /** Orders — create, list, get, cancel, redispatch, quote, rate. */
  readonly orders: OrdersResource;

  /** Finance reads for reconciliation — balance, summary, overview, ledger, settlements, statement.
   *  Read-only; settle requests and method management remain hub-only. */
  readonly finance: FinanceResource;

  /** Your workspace's own profile + integration settings — getProfile,
   *  updateProfile, rotateCredentials, setWebhookUrl. */
  readonly workspace: WorkspaceResource;

  /** Live driver-location tracking over socket.io. Socket is lazy — no connection
   *  until first subscribe(). Auto-closes when last subscription is removed. */
  readonly tracking: TrackingResource;

  /** Lower-level HTTP transport for untyped endpoints, with the same auth + retries
   *  + idempotency-key behavior as typed methods. */
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
