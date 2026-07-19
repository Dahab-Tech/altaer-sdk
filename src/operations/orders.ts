import type { HttpClient, RequestOptions } from '../http';
import type {
  CancelOrderInput,
  CreateOrderInput,
  ListOrdersInput,
  Order,
  OrderListResponse,
  Quote,
  QuoteInput,
  RateOrderInput,
  RatingResponse,
} from '../types';

// Orders resource. Mirrors POST/GET endpoints under
// /api/v1/workspaces/orders. Every method is async, fully typed, and
// surfaces the typed error classes from `../errors` on failure (see
// HttpClient for the mapping).

export class OrdersResource {
  constructor(private readonly http: HttpClient) {}

  /** Create a delivery order. The order enters `initiated` and progresses
   *  through dispatcher → driver acceptance → pickup → dropoff →
   *  completed. Status changes fire `order.*` webhooks to your endpoint.
   *
   *  Pass an `idempotencyKey` to make safe retries return the original
   *  result instead of double-dispatching. If omitted, the SDK auto-
   *  generates one per call. */
  async create(input: CreateOrderInput, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>('/api/v1/workspaces/orders', input, opts);
  }

  /** Fetch the current state of one order. Polling is supported but
   *  webhooks are strongly preferred — they push status changes in
   *  near-real-time with delivery guarantees + signatures. */
  async get(orderId: number, opts?: RequestOptions): Promise<Order> {
    return this.http.get<Order>(`/api/v1/workspaces/orders/${orderId}`, opts);
  }

  /** List your orders. Default page = first 10. `since` / `until` filter
   *  by `createdAt` (inclusive YYYY-MM-DD bounds; omit either side for
   *  unbounded on that edge). */
  async list(input?: ListOrdersInput, opts?: RequestOptions): Promise<OrderListResponse> {
    const params = new URLSearchParams();
    if (input?.limit !== undefined) params.set('limit', String(input.limit));
    if (input?.offset !== undefined) params.set('offset', String(input.offset));
    if (input?.since) params.set('since', input.since);
    if (input?.until) params.set('until', input.until);
    const qs = params.toString();
    return this.http.get<OrderListResponse>(`/api/v1/workspaces/orders${qs ? `?${qs}` : ''}`, opts);
  }

  /** Cancel an order. `canceledBy` attributes the cancel to `pickup`
   *  (sender), `dropoff` (recipient), or `workspace` (default) — audit
   *  trail only, economics are identical across the three. `driver` /
   *  `system` are reserved for the driver app and server jobs; sending
   *  them falls back to `workspace`, so integrators can't forge the
   *  driver-cancel ledger penalty. `pickup` is rejected once the driver
   *  has the goods (409).
   *
   *  Pre-pickup cancels are free — no money moves. Post-pickup cancels
   *  may carry charges; the driver still earns, and the response's
   *  `financials` block shows the effect. */
  async cancel(orderId: number, input?: CancelOrderInput, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>(`/api/v1/workspaces/orders/${orderId}/cancel`, input ?? {}, opts);
  }

  /** Re-run dispatch on an order that ended in `noDriverFound`. The
   *  same order id stays put; status flips back to `initiated` and the
   *  same dispatch worker runs again. Other statuses return 409
   *  ConflictError. */
  async redispatch(orderId: number, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>(`/api/v1/workspaces/orders/${orderId}/redispatch`, {}, opts);
  }

  /** Price-only delivery quote (no order created, no driver dispatched).
   *  Use this to show the workspace the delivery fee before they commit
   *  to placing the order. */
  async quote(input: QuoteInput, opts?: RequestOptions): Promise<Quote> {
    return this.http.post<Quote>('/api/v1/workspaces/orders/quote', input, opts);
  }

  /** Rate the driver of a completed delivery. The platform accepts up
   *  to 2 ratings per delivery — one for the pickup-side party
   *  (cook/sender) and one for the dropoff-side party (recipient).
   *  Both blend into the driver's rolling average. */
  async rate(
    orderId: number,
    input: RateOrderInput,
    opts?: RequestOptions
  ): Promise<RatingResponse> {
    return this.http.post<RatingResponse>(
      `/api/v1/workspaces/orders/${orderId}/rating`,
      input,
      opts
    );
  }
}
