import { io, type Socket } from 'socket.io-client';

// Live tracking over socket.io. Socket is lazy (REST-only callers pay nothing).
// Server state is in-memory — reconnect drops all leases; SDK re-emits order:subscribe on connect.
// Terminal refusals (order_terminal, not_found_or_forbidden, plan limit) set terminal:true and stop renewal.
// Wire: auth:{apiKey} → order:subscribe{orderId} ack → s→c order:driverLocation{orderId,lat,lng,at}.

/** Driver location push payload. `at` is a unix-ms timestamp from the
 *  server, sourced from when the driver app last reported the position
 *  (NOT when the platform pushed it) — use it to detect a stale fix. */
export interface DriverLocationUpdate {
  orderId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  at: number;
}

/** Server ack for `order:subscribe`. OK branch carries TTL seconds used to
 *  schedule lease renewal. Error includes `limit`+`used` on subscription_limit_exceeded. */
export type SubscribeAck =
  | { ok: true; ttlSec: number }
  | { ok: false; error: string; limit?: number; used?: number };

/** Error codes the SDK normalizes into onError; anything else surfaces as a generic string. */
export type TrackingErrorCode =
  | 'subscription_limit_exceeded'
  | 'not_found_or_forbidden'
  | 'order_terminal'
  | 'invalid_orderId'
  | 'socket_error'
  | 'unknown';

export interface TrackingError {
  code: TrackingErrorCode | string;
  message: string;
  /** True = server refuses this order forever (SDK stopped renewing — release UI).
   *  False = transient (socket drop): subscription stays registered, SDK retries on reconnect. */
  terminal: boolean;
  /** Present on `subscription_limit_exceeded` — the tenant's plan cap. */
  limit?: number;
  /** Present on `subscription_limit_exceeded` — currently active subs. */
  used?: number;
}

export interface SubscribeHandlers {
  /** Driver moved. Deduped server-side. Late-attaching listeners receive the
   *  last cached position asynchronously before live pushes begin. */
  onLocation?: (update: DriverLocationUpdate) => void | Promise<void>;
  /** Subscribe/renewal failed or connection broke. Check `err.terminal`:
   *  true = SDK gave up (sub removed); false = transient, SDK retries on reconnect. */
  onError?: (err: TrackingError) => void | Promise<void>;
}

/** Handle from `client.tracking.subscribe(...)`. Multiple handles on the same order
 *  share one server-side lease; `unsubscribe()` detaches only this handle. */
export interface OrderSubscription {
  readonly orderId: string;
  /** True while handle is attached and the server-side lease is live. */
  readonly active: boolean;
  unsubscribe(): Promise<void>;
}

export interface TrackingConfig {
  /** Override the auto-derived socket URL. Defaults to `baseUrl`. */
  url?: string;
  /** Fraction of TTL at which lease renewal fires. Default 0.7 (clamped 0.01–0.95). */
  leaseRenewalRatio?: number;
}

// ── Internal subscription state ──────────────────────────────────────

interface ListenerInternal {
  id: number;
  handlers: SubscribeHandlers;
}

interface SubInternal {
  orderId: string;
  /** Every attached listener, keyed by listener id. One wire subscription fans out to all. */
  listeners: Map<number, ListenerInternal>;
  /** True while the SDK holds a live server-side lease. */
  active: boolean;
  renewTimer: ReturnType<typeof setTimeout> | null;
  /** Most recent push, replayed asynchronously to late-joining listeners. */
  lastLocation: DriverLocationUpdate | null;
  /** Coalesces concurrent first-subscribe calls to one order:subscribe emit. */
  pending: Promise<void> | null;
}

const DEFAULT_LEASE_RENEWAL_RATIO = 0.7;
const MIN_RENEWAL_MS = 1_000;

// Refusals the server repeats forever for this order — renewing or
// resubscribing would loop the same error. Mirrors the ack codes in the
// server's orderTrackingService.
const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'subscription_limit_exceeded',
  'not_found_or_forbidden',
  'order_terminal',
  'invalid_orderId',
]);

export class TrackingResource {
  private socket: Socket | null = null;
  private readonly subs = new Map<string, SubInternal>();
  private nextListenerId = 1;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly urlOverride: string | null;
  private readonly leaseRatio: number;

  constructor(opts: { apiKey: string; baseUrl: string; tracking?: TrackingConfig }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.urlOverride = opts.tracking?.url ?? null;
    const ratio = opts.tracking?.leaseRenewalRatio ?? DEFAULT_LEASE_RENEWAL_RATIO;
    this.leaseRatio = Math.min(Math.max(ratio, 0.01), 0.95);
  }

  /** Subscribe to driver-location pushes for an order. Resolves once the server
   *  holds a live lease (or immediately if already tracked). Multiple calls share
   *  one server-side subscription; each handle detaches only itself. Rejects with
   *  TrackingError on refusal — check `terminal` to know if retrying can succeed. */
  async subscribe(orderId: string, handlers: SubscribeHandlers = {}): Promise<OrderSubscription> {
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error(
        `TrackingResource.subscribe: orderId must be a non-empty string, got ${orderId}`
      );
    }

    let sub = this.subs.get(orderId);
    if (!sub) {
      sub = {
        orderId,
        listeners: new Map(),
        active: false,
        renewTimer: null,
        lastLocation: null,
        pending: null,
      };
      this.subs.set(orderId, sub);
    }

    const listener: ListenerInternal = { id: this.nextListenerId++, handlers };
    sub.listeners.set(listener.id, listener);

    if (sub.active) {
      // Wire lease already live — the new listener just attaches.
      this._replayLast(sub, listener);
      return this._toPublicSubscription(sub, listener);
    }

    try {
      await this._wireSubscribe(sub);
    } catch (raw) {
      sub.listeners.delete(listener.id);
      if (sub.listeners.size === 0 && this.subs.get(orderId) === sub) {
        this.subs.delete(orderId);
        // Without this a failed FIRST-ever subscribe would leak a
        // socket that reconnects forever with nothing subscribed.
        this._maybeIdleDisconnect();
      }
      throw this._normalizeError(raw);
    }
    return this._toPublicSubscription(sub, listener);
  }

  /** Close the socket and tear down all subscriptions. Call on graceful shutdown;
   *  otherwise the SDK manages lifecycle automatically. */
  async close(): Promise<void> {
    for (const sub of this.subs.values()) {
      if (sub.renewTimer) clearTimeout(sub.renewTimer);
      sub.active = false;
    }
    this.subs.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _toPublicSubscription(sub: SubInternal, listener: ListenerInternal): OrderSubscription {
    return {
      orderId: sub.orderId,
      get active() {
        return sub.active && sub.listeners.has(listener.id);
      },
      unsubscribe: async () => {
        await this._detachListener(sub, listener);
      },
    };
  }

  /** One order:subscribe round-trip per sub regardless of concurrent callers. */
  private _wireSubscribe(sub: SubInternal): Promise<void> {
    if (sub.pending) return sub.pending;
    const p = (async () => {
      await this._ensureConnected();
      await this._sendSubscribe(sub.orderId);
    })();
    sub.pending = p;
    const clear = (): void => {
      if (sub.pending === p) sub.pending = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** Replay last cached position to a late-attaching listener. Async so it
   *  arrives after subscribe() returns, never re-entrantly. */
  private _replayLast(sub: SubInternal, listener: ListenerInternal): void {
    const snapshot = sub.lastLocation;
    const onLocation = listener.handlers.onLocation;
    if (!snapshot || !onLocation) return;
    setTimeout(() => {
      if (!sub.listeners.has(listener.id)) return; // unsubscribed already
      // A fresher live push has been dispatched in the meantime —
      // replaying the older snapshot now would arrive out of order.
      if (sub.lastLocation !== snapshot) return;
      try {
        void onLocation(snapshot);
      } catch {
        // Consumer handler errors never break the SDK.
      }
    }, 0);
  }

  private async _detachListener(sub: SubInternal, listener: ListenerInternal): Promise<void> {
    if (!sub.listeners.delete(listener.id)) return; // already detached
    if (sub.listeners.size > 0) return; // others still listening — keep the wire sub
    if (this.subs.get(sub.orderId) !== sub) return; // sub already torn down

    if (sub.renewTimer) {
      clearTimeout(sub.renewTimer);
      sub.renewTimer = null;
    }
    sub.active = false;
    this.subs.delete(sub.orderId);

    // Best-effort emit. If the socket is dead, the server will reap
    // the sub via the disconnect cleanup anyway, so a failed ack here
    // doesn't matter.
    if (this.socket?.connected) {
      try {
        await this._emitWithAck<{ ok: boolean }>('order:unsubscribe', { orderId: sub.orderId });
      } catch {
        // swallow — see above
      }
    }

    this._maybeIdleDisconnect();
  }

  private async _ensureConnected(): Promise<void> {
    if (this.socket?.connected) return;
    if (!this.socket) {
      this.socket = io(this.urlOverride ?? this.baseUrl, {
        auth: { apiKey: this.apiKey },
        // Defaults are sane: reconnection on, exponential backoff, no
        // upper attempt cap. We handle resubscribe on `connect`.
        transports: ['websocket', 'polling'],
      });
      this._wireSocketListeners(this.socket);
    }
    const sock = this.socket;
    if (sock.connected) return;
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        sock.off('connect_error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        sock.off('connect', onConnect);
        reject(err);
      };
      sock.once('connect', onConnect);
      sock.once('connect_error', onError);
    });
  }

  private _wireSocketListeners(sock: Socket): void {
    sock.on('order:driverLocation', (payload: DriverLocationUpdate) => {
      const sub = this.subs.get(payload.orderId);
      if (!sub) return;
      // Cache before dispatch so a subscribe() made from inside a
      // handler replays THIS fix, not the previous one.
      sub.lastLocation = payload;
      for (const listener of sub.listeners.values()) {
        if (!listener.handlers.onLocation) continue;
        try {
          void listener.handlers.onLocation(payload);
        } catch {
          // One consumer handler throwing must not starve the other
          // listeners or kill the socket listener.
        }
      }
    });

    sock.on('connect', () => {
      // Server's tracking state is in-memory, so any reconnect (even
      // a graceful one) drops every sub server-side. Re-subscribe each
      // tracked order in parallel — idempotent on the server.
      for (const sub of this.subs.values()) {
        void this._sendSubscribe(sub.orderId).catch((raw: unknown) => {
          this._handleWireError(sub, raw);
        });
      }
    });

    sock.on('disconnect', () => {
      // Stop renewal timers — they'd just fire and re-trigger a
      // reconnect-then-renew loop. The `connect` handler will
      // re-subscribe (and re-schedule renewal) on reconnect.
      for (const sub of this.subs.values()) {
        if (sub.renewTimer) {
          clearTimeout(sub.renewTimer);
          sub.renewTimer = null;
        }
        sub.active = false;
      }
    });

    sock.on('connect_error', (err: Error) => {
      // Surface to every listener's onError. Real connect-time auth
      // failure (bad apiKey, tenant not provisioned) lands here.
      const trackErr: TrackingError = {
        code: 'socket_error',
        message: err.message,
        terminal: false,
      };
      for (const sub of this.subs.values()) {
        this._dispatchError(sub, trackErr);
      }
    });
  }

  private async _sendSubscribe(orderId: string): Promise<void> {
    const sub = this.subs.get(orderId);
    if (!sub) return;

    const ack = await this._emitWithAck<SubscribeAck>('order:subscribe', { orderId });
    if (!ack.ok) {
      sub.active = false;
      const err: TrackingError = {
        code: ack.error,
        message: this._messageForCode(ack.error),
        terminal: TERMINAL_ERROR_CODES.has(ack.error),
        limit: ack.limit,
        used: ack.used,
      };
      throw err;
    }

    sub.active = true;
    this._scheduleRenewal(sub, ack.ttlSec);
  }

  private _scheduleRenewal(sub: SubInternal, ttlSec: number): void {
    if (sub.renewTimer) clearTimeout(sub.renewTimer);
    const renewMs = Math.max(MIN_RENEWAL_MS, Math.floor(ttlSec * 1000 * this.leaseRatio));
    sub.renewTimer = setTimeout(() => {
      if (this.subs.get(sub.orderId) !== sub) return; // torn down meanwhile
      // Only renew if we're still connected; on disconnect the
      // `connect` handler will re-subscribe on reconnect anyway.
      if (!this.socket?.connected) return;
      void this._sendSubscribe(sub.orderId).catch((raw: unknown) => {
        this._handleWireError(sub, raw);
      });
    }, renewMs);
  }

  /** Renewal/reconnect-resubscribe failed. Terminal refusals tear the sub down
   *  before dispatch so a re-subscribing handler sees a clean slate. */
  private _handleWireError(sub: SubInternal, raw: unknown): void {
    const err = this._normalizeError(raw);
    if (err.terminal) {
      // No wire unsubscribe emit: the server already dropped (or never
      // held) the lease for a terminal refusal.
      this._teardownSub(sub);
    }
    this._dispatchError(sub, err);
  }

  private _teardownSub(sub: SubInternal): void {
    if (sub.renewTimer) {
      clearTimeout(sub.renewTimer);
      sub.renewTimer = null;
    }
    sub.active = false;
    if (this.subs.get(sub.orderId) === sub) {
      this.subs.delete(sub.orderId);
    }
    this._maybeIdleDisconnect();
  }

  /** Drop the socket when no subscriptions remain — prevents idle TCP connections. */
  private _maybeIdleDisconnect(): void {
    if (this.subs.size === 0 && this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  private _normalizeError(raw: unknown): TrackingError {
    if (raw && typeof raw === 'object' && 'code' in raw && 'message' in raw) {
      const err = raw as TrackingError;
      return {
        ...err,
        terminal:
          typeof err.terminal === 'boolean'
            ? err.terminal
            : TERMINAL_ERROR_CODES.has(String(err.code)),
      };
    }
    return {
      code: 'socket_error',
      message: raw instanceof Error ? raw.message : String(raw),
      terminal: false,
    };
  }

  private _dispatchError(sub: SubInternal, err: TrackingError): void {
    for (const listener of sub.listeners.values()) {
      if (!listener.handlers.onError) continue;
      try {
        void listener.handlers.onError(err);
      } catch {
        // Consumer handler errors never escape into the socket.
      }
    }
  }

  private _emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error(`tracking: cannot emit '${event}' — socket not connected`));
        return;
      }
      // socket.io ack timeout. 10s is long enough to survive a tab
      // throttle / GC pause but short enough that a wedged server
      // shows up promptly.
      const timer = setTimeout(() => {
        reject(new Error(`tracking: '${event}' ack timed out`));
      }, 10_000);
      this.socket.emit(event, payload, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  private _messageForCode(code: string): string {
    switch (code) {
      case 'subscription_limit_exceeded':
        return 'Tenant subscription limit reached. Upgrade plan or unsubscribe from an older order to subscribe to a new one.';
      case 'not_found_or_forbidden':
        return 'Order does not exist for this tenant.';
      case 'order_terminal':
        return 'Order has reached a terminal state (completed, canceled, rejected, or failed) — no further tracking.';
      case 'invalid_orderId':
        return 'Server rejected the orderId as malformed.';
      default:
        return code;
    }
  }
}
