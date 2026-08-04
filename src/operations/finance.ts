import type { HttpClient, RequestOptions } from '../http';
import type {
  BalanceResponse,
  FinanceLedgerCountInput,
  FinancePaginationInput,
  FinanceReportInput,
  FinanceReportTotalsInput,
  FinanceSettlementsCountInput,
  LedgerCountResponse,
  LedgerListResponse,
  PnlPerOrderItemsPage,
  PnlPerOrderTotalsResponse,
  SettlementCountResponse,
  SettlementListResponse,
  SettlementWithItems,
  Statement,
  StatementInput,
} from '../types';

// Read-only finance resource. Mirrors /api/v1/workspaces/me/finance/*.
// Mutating actions (settle requests, payment methods, secret rotation) stay hub-only.

export class FinanceResource {
  constructor(private readonly http: HttpClient) {}

  /** Three balance slices in one call — see `BalanceResponse` for the
   *  nullable envelope. Non-null presence tells you which slices apply
   *  to this tenant (pure network users only see `workspaceAltaer`;
   *  own-fleet operators see all three). */
  async balance(opts?: RequestOptions): Promise<BalanceResponse> {
    return this.http.get<BalanceResponse>('/api/v1/workspaces/me/finance/balance', opts);
  }

  /** Paginated ledger grouped per order — one item per order in the
   *  window (newest first), carrying that order's ledger legs. Pages
   *  never split same-order legs. Settlements + adjustments don't
   *  appear here (use `settlements(...)` instead). Call `ledgerCount`
   *  for the total order count in the same window. */
  async ledger(input?: FinancePaginationInput, opts?: RequestOptions): Promise<LedgerListResponse> {
    return this.http.get<LedgerListResponse>(
      `/api/v1/workspaces/me/finance/ledger${paginationQs(input)}`,
      opts
    );
  }

  /** Total number of orders in the same window `ledger(...)` slices.
   *  Cache per window — refetch only on window (`since`/`until`) change,
   *  not on every page flip. */
  async ledgerCount(
    input?: FinanceLedgerCountInput,
    opts?: RequestOptions
  ): Promise<LedgerCountResponse> {
    const params = new URLSearchParams();
    if (input?.since) params.set('since', input.since);
    if (input?.until) params.set('until', input.until);
    const qs = params.toString();
    return this.http.get<LedgerCountResponse>(
      `/api/v1/workspaces/me/finance/ledger/count${qs ? `?${qs}` : ''}`,
      opts
    );
  }

  /** Paginated settlement history. `direction='collected_from'` means
   *  the platform took cash FROM you; `direction='paid_to'` means the
   *  platform paid cash TO you. Call `settlementsCount` for the total
   *  count in the same window (cache across page flips). */
  async settlements(
    input?: FinancePaginationInput,
    opts?: RequestOptions
  ): Promise<SettlementListResponse> {
    return this.http.get<SettlementListResponse>(
      `/api/v1/workspaces/me/finance/settlements${paginationQs(input)}`,
      opts
    );
  }

  /** Total number of settlements in the same window
   *  `settlements(...)` slices. Cache per window — refetch only on
   *  window (`since`/`until`) change, not on every page flip. */
  async settlementsCount(
    input?: FinanceSettlementsCountInput,
    opts?: RequestOptions
  ): Promise<SettlementCountResponse> {
    const params = new URLSearchParams();
    if (input?.since) params.set('since', input.since);
    if (input?.until) params.set('until', input.until);
    const qs = params.toString();
    return this.http.get<SettlementCountResponse>(
      `/api/v1/workspaces/me/finance/settlements/count${qs ? `?${qs}` : ''}`,
      opts
    );
  }

  /** Per-order P&L report. One row per completed/canceled order in the
   *  window, workspace-perspective P&L (`income` = merchant slice +
   *  punitive recoveries, `cost` = delivery fee + priced VAT, `net` =
   *  income − cost). Call `reportTotals(...)` for per-currency
   *  whole-window sums + order count (cache across page flips). */
  async report(input?: FinanceReportInput, opts?: RequestOptions): Promise<PnlPerOrderItemsPage> {
    return this.http.get<PnlPerOrderItemsPage>(
      `/api/v1/workspaces/me/finance/reports/pnl-per-order${paginationQs(input)}`,
      opts
    );
  }

  /** Whole-window per-currency P&L totals + order count for the same
   *  window `report(...)` slices. Cache per window — refetch only on
   *  window change, not on every page flip. */
  async reportTotals(
    input?: FinanceReportTotalsInput,
    opts?: RequestOptions
  ): Promise<PnlPerOrderTotalsResponse> {
    const params = new URLSearchParams();
    if (input?.since) params.set('since', input.since);
    if (input?.until) params.set('until', input.until);
    const qs = params.toString();
    return this.http.get<PnlPerOrderTotalsResponse>(
      `/api/v1/workspaces/me/finance/reports/pnl-per-order/totals${qs ? `?${qs}` : ''}`,
      opts
    );
  }

  /** One settlement plus per-order items tagged by `origin`+`type`. Use for
   *  line-by-line audit when the settle webhook's `breakdown.<origin>` totals aren't enough. */
  async getSettlement(id: string, opts?: RequestOptions): Promise<SettlementWithItems> {
    return this.http.get<SettlementWithItems>(
      `/api/v1/workspaces/me/finance/settlements/${encodeURIComponent(String(id))}`,
      opts
    );
  }

  /** Closed-window statement for monthly reconciliation. Includes
   *  opening + closing balances, a per-window summary, and a page of
   *  entries. Defaults to the last 30 days when called with no args.
   *  Window is inclusive on both ends.
   *
   *  `entries` paginates (default limit=50, max 200). `openingBalance`,
   *  `closingBalance`, `total`, and `summary` are window-scoped and
   *  stay identical across every page in the same window. */
  async statement(input?: StatementInput, opts?: RequestOptions): Promise<Statement> {
    const params = new URLSearchParams();
    if (input?.fromDate) params.set('fromDate', input.fromDate);
    if (input?.toDate) params.set('toDate', input.toDate);
    if (input?.limit !== undefined) params.set('limit', String(input.limit));
    if (input?.offset !== undefined) params.set('offset', String(input.offset));
    const qs = params.toString();
    return this.http.get<Statement>(
      `/api/v1/workspaces/me/finance/statement${qs ? `?${qs}` : ''}`,
      opts
    );
  }
}

const paginationQs = (input?: FinancePaginationInput): string => {
  const params = new URLSearchParams();
  if (input?.limit !== undefined) params.set('limit', String(input.limit));
  if (input?.offset !== undefined) params.set('offset', String(input.offset));
  if (input?.since) params.set('since', input.since);
  if (input?.until) params.set('until', input.until);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};
