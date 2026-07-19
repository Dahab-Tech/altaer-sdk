import type { HttpClient, RequestOptions } from '../http';
import type {
  BalanceResponse,
  FinanceOverview,
  FinanceOverviewInput,
  FinancePaginationInput,
  FinanceSummary,
  LedgerListResponse,
  SettlementListResponse,
  SettlementWithItems,
  Statement,
  StatementInput,
} from '../types';

// Read-only finance resource. Mirrors the server-to-server endpoints
// under /api/v1/workspaces/me/finance/* — the same data the hub renders,
// authed via x-api-key so your backend can reconcile Altaer's books
// against yours without scraping the dashboard.
//
// Mutating actions (request a settle, manage payment methods, rotate
// secrets) are deliberately NOT in the SDK — those are operator
// decisions that stay in the hub.

export class FinanceResource {
  constructor(private readonly http: HttpClient) {}

  /** Current signed balance with the platform. Positive = you owe;
   *  negative = the platform owes you. Integer minor units of the
   *  workspace currency. */
  async balance(opts?: RequestOptions): Promise<BalanceResponse> {
    return this.http.get<BalanceResponse>('/api/v1/workspaces/me/finance/balance', opts);
  }

  /** Lifetime aggregate of every ledger row tied to your workspace,
   *  split by entry type. Single-currency by contract (your workspace
   *  currency is immutable post-create). */
  async summary(opts?: RequestOptions): Promise<FinanceSummary> {
    return this.http.get<FinanceSummary>('/api/v1/workspaces/me/finance/summary', opts);
  }

  /** Tenant-perspective rollup for dashboards. Pass `since` to scope to
   *  a window (e.g. start of month) for a clean monthly view. All money
   *  fields are integer minor units of the workspace currency. */
  async overview(input?: FinanceOverviewInput, opts?: RequestOptions): Promise<FinanceOverview> {
    const params = new URLSearchParams();
    if (input?.since) params.set('since', input.since);
    const qs = params.toString();
    return this.http.get<FinanceOverview>(
      `/api/v1/workspaces/me/finance/overview${qs ? `?${qs}` : ''}`,
      opts
    );
  }

  /** Paginated per-row ledger history. Newest first. Each row exposes
   *  a `workspaceAmountMinor` + `workspaceDirection` pair (always
   *  positive magnitude + labeled direction enum) — sign it your way
   *  when mirroring into your own books. `workspace_debit` = the row
   *  increases what the workspace owes the platform; `workspace_credit`
   *  = the row decreases it (or the platform owes the workspace on
   *  this row). */
  async ledger(input?: FinancePaginationInput, opts?: RequestOptions): Promise<LedgerListResponse> {
    return this.http.get<LedgerListResponse>(
      `/api/v1/workspaces/me/finance/ledger${_paginationQs(input)}`,
      opts
    );
  }

  /** Paginated settlement history. `direction='collected_from'` means
   *  the platform took cash FROM you; `direction='paid_to'` means the
   *  platform paid cash TO you. */
  async settlements(
    input?: FinancePaginationInput,
    opts?: RequestOptions
  ): Promise<SettlementListResponse> {
    return this.http.get<SettlementListResponse>(
      `/api/v1/workspaces/me/finance/settlements${_paginationQs(input)}`,
      opts
    );
  }

  /** One settlement plus its per-order item detail. Items are returned
   *  as a flat array tagged by `origin` and `type`. Use for line-by-
   *  line audit / reconciliation when the webhook's `breakdown` totals
   *  aren't enough (most reconciliation can skip this — the settle
   *  webhook's `breakdown.<origin>` already carries the signed slice
   *  totals). */
  async getSettlement(id: number, opts?: RequestOptions): Promise<SettlementWithItems> {
    return this.http.get<SettlementWithItems>(
      `/api/v1/workspaces/me/finance/settlements/${encodeURIComponent(String(id))}`,
      opts
    );
  }

  /** Closed-window statement for monthly reconciliation. Includes
   *  opening + closing balances and every entry in range. Defaults to
   *  the last 30 days when called with no args. Window is inclusive
   *  on both ends. */
  async statement(input?: StatementInput, opts?: RequestOptions): Promise<Statement> {
    const params = new URLSearchParams();
    if (input?.fromDate) params.set('fromDate', input.fromDate);
    if (input?.toDate) params.set('toDate', input.toDate);
    const qs = params.toString();
    return this.http.get<Statement>(
      `/api/v1/workspaces/me/finance/statement${qs ? `?${qs}` : ''}`,
      opts
    );
  }
}

const _paginationQs = (input?: FinancePaginationInput): string => {
  const params = new URLSearchParams();
  if (input?.limit !== undefined) params.set('limit', String(input.limit));
  if (input?.offset !== undefined) params.set('offset', String(input.offset));
  if (input?.since) params.set('since', input.since);
  if (input?.until) params.set('until', input.until);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};
