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

// Orders resource. Mirrors /api/v1/workspaces/orders endpoints.

export class OrdersResource {
  constructor(private readonly http: HttpClient) {}

  /** Create a delivery order. Status changes fire `order.*` webhooks. Pass an
   *  `idempotencyKey` to make retries safe; auto-generated per call if omitted. */
  async create(input: CreateOrderInput, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>('/api/v1/workspaces/orders', input, opts);
  }

  /** Fetch the current state of one order. Polling is supported but
   *  webhooks are strongly preferred — they push status changes in
   *  near-real-time with delivery guarantees + signatures. */
  async get(orderId: string, opts?: RequestOptions): Promise<Order> {
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

  /** Cancel an order. `canceledBy` is audit-trail only; reserved `driver`/`system` are rejected
   *  with 400 `validation/invalid_format` (prevents forging driver-cancel penalty). `pickup`
   *  rejected post-goods (409). Pre-pickup is free; post-pickup may charge — see `financials`.
   *  Idempotent. */
  async cancel(orderId: string, input?: CancelOrderInput, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>(`/api/v1/workspaces/orders/${orderId}/cancel`, input ?? {}, opts);
  }

  /** Send a completed returnable order back (RMA). Creates a linked return
   *  order — addresses reversed, normal dispatch and pricing, workspace-paid
   *  (`merchantAmount: 0`). One live return per original (409 otherwise). */
  async createReturn(orderId: string, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>(`/api/v1/workspaces/orders/${orderId}/return`, {}, opts);
  }

  /** Re-run dispatch on an order that ended in `noDriverFound`. The
   *  same order id stays put; status flips back to `initiated` and the
   *  same dispatch worker runs again. Other statuses return 409
   *  ConflictError. */
  async redispatch(orderId: string, opts?: RequestOptions): Promise<Order> {
    return this.http.post<Order>(`/api/v1/workspaces/orders/${orderId}/redispatch`, {}, opts);
  }

  /** Price-only delivery quote (no order created, no driver dispatched).
   *  Use this to show the workspace the delivery fee before they commit
   *  to placing the order. */
  async quote(input: QuoteInput, opts?: RequestOptions): Promise<Quote> {
    return this.http.post<Quote>('/api/v1/workspaces/orders/quote', input, opts);
  }

  /** Rate the driver of a delivery. Ratable once `completed` or `canceled` after driver
   *  engagement (409 otherwise). Up to 2 ratings per delivery (pickup/dropoff); repeats overwrite. */
  async rate(
    orderId: string,
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
