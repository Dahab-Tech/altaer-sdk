import type { HttpClient, RequestOptions } from '../http';
import type {
  RotateCredentialsResponse,
  SetWebhookUrlResponse,
  UpdateWorkspaceProfileInput,
  WorkspaceProfile,
} from '../types';

// Workspace resource. Mirrors /api/v1/workspaces self-service endpoints.

export class WorkspaceResource {
  constructor(private readonly http: HttpClient) {}

  /** Fetch your workspace profile — the workspace your API key belongs
   *  to. Secrets are never returned; `dev.keyLast4` lets you confirm
   *  which key the integration holds. */
  async getProfile(opts?: RequestOptions): Promise<WorkspaceProfile> {
    return this.http.get<WorkspaceProfile>('/api/v1/workspaces/profile', opts);
  }

  /** Update profile fields. Send only what you're changing — updatable
   *  fields are `name`, `tradeName`, `branchAddress`, `industry`,
   *  `operatingHours`, `timeZone`. Unknown fields are rejected with a
   *  400 (nothing is silently dropped). Returns the updated profile. */
  async updateProfile(
    input: UpdateWorkspaceProfileInput,
    opts?: RequestOptions
  ): Promise<WorkspaceProfile> {
    return this.http.put<WorkspaceProfile>('/api/v1/workspaces/profile', input, opts);
  }

  /** Rotate the API key. New key is in the response ONCE — store it immediately.
   *  Old key stops working right away; this client instance is stale after the call.
   *  Webhook signing secret is separate and rotates from the hub. */
  async rotateCredentials(opts?: RequestOptions): Promise<RotateCredentialsResponse> {
    return this.http.post<RotateCredentialsResponse>(
      '/api/v1/workspaces/regenerate-credentials',
      {},
      opts
    );
  }

  /** Point webhook delivery at a new consumer URL, or pass `null` to
   *  clear it (delivery stops until a new URL is set). Must be http(s);
   *  in production the host must be publicly routable. */
  async setWebhookUrl(
    webhookUrl: string | null,
    opts?: RequestOptions
  ): Promise<SetWebhookUrlResponse> {
    return this.http.put<SetWebhookUrlResponse>('/api/v1/workspaces/webhook', { webhookUrl }, opts);
  }
}
