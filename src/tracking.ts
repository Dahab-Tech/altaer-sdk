import { io, type Socket } from 'socket.io-client';

// Live order tracking over socket.io. Wraps the platform's tenant
// socket channel so partners get a one-line subscribe with handlers,
// and the SDK transparently handles:
//
//   • lazy connect          — the socket opens on first subscribe(),
//                             not at AltaerClient construction. REST-only
//                             callers never pay the connection cost.
//   • listener multiplexing — multiple subscribe() calls for the same
//                             order are independent listeners sharing ONE
//                             server-side subscription (so they count
//                             once against the tenant subscription
//                             limit). Each handle's unsubscribe() detaches
//                             only itself; the wire subscription is
//                             released when the last listener detaches.
//   • last-location replay  — a listener attaching to an order that is
//                             already streaming receives the most recent
//                             position immediately (async), then live
//                             pushes. Late joiners don't stare at an
//                             empty map until the driver next moves.
//   • lease renewal         — the server's subscription lease lapses
//                             after `trackingSubscriptionTtlMs` (default
//                             60s). We re-emit `order:subscribe` at 70%
//                             of `ttlSec` so the renew lands well before
//                             expiry under jittery networks.
//   • reconnect resubscribe — server tracking state is in-memory, so any
//                             reconnect drops every subscription. On
//                             socket.io's `connect` event we re-emit
//                             `order:subscribe` for every active order.
//                             Idempotent server-side.
//   • terminal errors       — refusals the server will repeat forever
//                             (order finished, not this tenant's order,
//                             plan limit) carry `terminal: true` and the
//                             SDK stops renewing/resubscribing that
//                             order. Transient errors (`terminal: false`,
//                             e.g. a socket drop) keep the subscription
//                             registered and retry on reconnect.
//   • idle disconnect       — when the last subscription is removed, the
//                             socket is closed so a long-lived client
//                             without active orders doesn't keep a TCP
//                             connection open.
//
// Wire protocol (server side: socketServiceWorkspace.ts +
// orderTrackingService.ts):
//
//   handshake  auth: { apiKey }
//   c→s        emit  'order:subscribe'   { orderId }   ack: SubscribeAck
//   c→s        emit  'order:unsubscribe' { orderId }   ack: { ok }
//   s→c       'order:driverLocation' { orderId, driverId, latitude,
//                                     longitude, at }
//
// The server enforces per-tenant authorization on subscribe — a tenant
// can only ever track its own orders. Cross-tenant attempts come back
// as { ok: false, error: 'not_found_or_forbidden' }.

/** Driver location push payload. `at` is a unix-ms timestamp from the
 *  server, sourced from when the driver app last reported the position
 *  (NOT when the platform pushed it) — use it to detect a stale fix. */
export interface DriverLocationUpdate {
  orderId: number;
  driverId: number;
  latitude: number;
  longitude: number;
  at: number;
}

/** Server ack for `order:subscribe`. The OK branch carries the lease
 *  TTL in seconds; we use it to schedule lease renewal. The error
 *  branch surfaces a machine-readable reason — `subscription_limit_exceeded`
 *  also includes `limit` + `used` so the consumer UI can prompt the
 *  partner to upgrade. */
export type SubscribeAck =
  | { ok: true; ttlSec: number }
  | { ok: false; error: string; limit?: number; used?: number };

/** Subscription error codes the SDK normalizes into onError handlers.
 *  Anything else (e.g. an internal server error) surfaces as a generic
 *  string. */
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
  /** True when the server would refuse this order forever (order
   *  finished, not this tenant's order, plan limit hit) — the SDK has
   *  already stopped renewing/resubscribing, so release any UI tied to
   *  the stream. A fresh `subscribe()` is still allowed once the cause
   *  is fixed (e.g. after unsubscribing another order on a limit error).
   *  False = transient (socket drop, ack timeout): the subscription
   *  stays registered and the SDK retries on reconnect. */
  terminal: boolean;
  /** Present on `subscription_limit_exceeded` — the tenant's plan cap. */
  limit?: number;
  /** Present on `subscription_limit_exceeded` — currently active subs. */
  used?: number;
}

export interface SubscribeHandlers {
  /** Driver moved (or first push after subscribe). The SDK dedupes
   *  identical positions server-side, so handler fires only on change.
   *  A listener attaching to an already-streaming order also receives
   *  the most recent cached position immediately (async). */
  onLocation?: (update: DriverLocationUpdate) => void | Promise<void>;
  /** Subscribe failed, lease renewal failed, or the connection broke.
   *  Check `err.terminal`: true means the SDK has given up on this
   *  order (no more retries) and the subscription is already removed;
   *  false means transient — the subscription stays registered and the
   *  SDK keeps retrying on reconnect (call `unsubscribe()` if you want
   *  to give up early). */
  onError?: (err: TrackingError) => void | Promise<void>;
}

/** Returned from `client.tracking.subscribe(...)`. Each call gets its
 *  own handle — multiple handles on the same order share one
 *  server-side subscription, and `unsubscribe()` detaches only this
 *  handle's listeners. The wire subscription (and, if it was the last
 *  one, the socket) is released when the final handle unsubscribes. */
export interface OrderSubscription {
  readonly orderId: number;
  /** Whether this handle is still attached AND the SDK believes the
   *  server-side lease is live. Flips to false after `unsubscribe()`,
   *  during a disconnect (until the automatic resubscribe lands), or
   *  after a terminal error. */
  readonly active: boolean;
  unsubscribe(): Promise<void>;
}

export interface TrackingConfig {
  /** Override the auto-derived socket URL. Defaults to the same `baseUrl`
   *  the REST client uses. */
  url?: string;
  /** Fraction of `ttlSec` at which we schedule lease renewal. Defaults
   *  to 0.7 — renews at 70% of the TTL so a renew has time to land
   *  before expiry under jittery networks. Clamped to (0, 0.95]. */
  leaseRenewalRatio?: number;
}

// ── Internal subscription state ──────────────────────────────────────

interface ListenerInternal {
  id: number;
  handlers: SubscribeHandlers;
}

interface SubInternal {
  orderId: number;
  /** Every attached listener, keyed by listener id. One wire
   *  subscription fans out to all of them. */
  listeners: Map<number, ListenerInternal>;
  /** Whether the SDK currently holds a live server-side lease. */
  active: boolean;
  renewTimer: ReturnType<typeof setTimeout> | null;
  /** Most recent push, replayed to late-joining listeners. */
  lastLocation: DriverLocationUpdate | null;
  /** Coalesces concurrent first-subscribe wire round-trips so N
   *  parallel subscribe() calls produce one `order:subscribe` emit. */
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
  private readonly subs = new Map<number, SubInternal>();
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

  /** Subscribe to driver-location pushes for an order. Resolves once
   *  the server holds a live lease — or immediately when this client
   *  already tracks the order: the new listener attaches to the
   *  existing lease and, if a position was already received, gets it
   *  replayed asynchronously.
   *
   *  Multiple subscribe() calls for the same order are independent
   *  listeners over ONE shared server-side subscription. Each returned
   *  handle detaches only itself; the wire subscription is released
   *  when the last handle unsubscribes.
   *
   *  Rejects with a `TrackingError` if the server refused — check
   *  `terminal` to know whether retrying can ever succeed.
   *
   *  The returned handle stays valid across reconnects; the SDK
   *  re-subscribes transparently. Call `handle.unsubscribe()` when done. */
  async subscribe(orderId: number, handlers: SubscribeHandlers = {}): Promise<OrderSubscription> {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new Error(
        `TrackingResource.subscribe: orderId must be a positive integer, got ${orderId}`
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

  /** Close the socket immediately and tear down every active
   *  subscription. Call this on graceful shutdown — otherwise the SDK
   *  manages the lifecycle automatically (lazy connect on first
   *  subscribe, idle disconnect after the last unsubscribe). */
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

  /** One `order:subscribe` round-trip per sub, no matter how many
   *  concurrent subscribe() calls await it. */
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

  /** Replay the cached last position to a listener that attached after
   *  the stream started. Async so the consumer receives it AFTER
   *  subscribe() returns the handle, never re-entrantly. */
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

  private async _sendSubscribe(orderId: number): Promise<void> {
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

  /** Renewal / reconnect-resubscribe failed. Terminal refusals tear the
   *  sub down BEFORE dispatch so a handler that re-subscribes sees a
   *  clean slate; transient ones leave the sub registered for the next
   *  reconnect attempt. */
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

  /** Last sub gone? Drop the socket so an idle client doesn't keep a
   *  TCP connection open. Next subscribe() re-opens lazily. */
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
