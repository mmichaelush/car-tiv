/**
 * The admin API, from the browser.
 *
 * Every request carries the staff token. It is held in `sessionStorage`, not
 * `localStorage`: closing the tab ends the session, which is the right default
 * for a shared or borrowed computer.
 */

import type { PageMeta } from '@shared/types/api.js';
import type { VideoStatus } from '@shared/constants.js';
import type { PagedResult } from './http-client.js';

const TOKEN_KEY = 'cartiv:admin-token';

export interface AdminVideo {
  readonly id: string;
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly channelName: string | null;
  readonly durationSeconds: number;
  readonly status: VideoStatus;
  readonly isFeatured: boolean;
  readonly isHebrew: boolean;
  readonly addedAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly tags: readonly string[];
  readonly openReports: number;
}

/** What the scheduled link checker has been doing. */
export interface MaintenanceStatus {
  readonly coverage: { total: number; checked: number; broken: number };
  readonly runs: readonly {
    ranAt: string;
    checked: number;
    broken: number;
    recovered: number;
    rowsPruned: number;
    countersRefreshed: number;
    durationMs: number;
  }[];
}

/**
 * How close this database is to the plan's limits.
 *
 * `estimatedBytes` is exactly that — an estimate. D1 reports its real size
 * through the Cloudflare API, not through SQL, so the Worker multiplies row
 * counts by the per-row averages measured in `docs/performance.md`. Good enough
 * to answer "are we at 4% or 40%?", which is the only question this screen asks.
 */
export interface ResourceStatus {
  readonly requests: {
    readonly limitPerDay: number;
    readonly perVisitor: number;
    readonly visitorsPerDay: number;
    readonly pageCosts: Readonly<Record<string, { first: number; again: number }>>;
  };
  readonly database: {
    readonly estimatedBytes: number;
    readonly limitBytes: number;
    readonly usedFraction: number;
    /** Months of headroom at the last thirty days' rate, or `null` if flat. */
    readonly monthsToLimit: number | null;
  };
  readonly tables: readonly {
    readonly table: string;
    readonly rows: number;
    readonly rowsThirtyDaysAgo: number | null;
    readonly estimatedBytes: number;
    readonly growthPerMonth: number | null;
  }[];
  readonly counters: { readonly lastRefreshedAt: string | null };
  readonly limits: {
    readonly workerRequestsPerDay: number;
    readonly rowsReadPerDay: number;
    readonly databaseBytes: number;
    readonly warnAtFraction: number;
  };
}

/** A bulk-import job, as the admin screen shows it. */
export interface ImportJob {
  readonly id: string;
  readonly filename: string;
  readonly sourceFormat: string;
  readonly status: string;
  readonly totalRows: number;
  readonly importedRows: number;
  readonly duplicateRows: number;
  readonly invalidRows: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly errorMessage: string;
}

export interface ImportRowError {
  readonly rowNumber: number;
  readonly field: string;
  readonly errorCode: string;
  readonly message: string;
}

export interface ImportOptions {
  readonly defaultCategoryId: string;
  readonly status: 'published' | 'pending';
  readonly updateExisting: boolean;
}

export interface AdminOverview {
  readonly counters: {
    videos: number;
    hidden: number;
    broken: number;
    deleted: number;
    channels: number;
    tags: number;
    addedThisWeek: number;
    addedThisMonth: number;
  };
  readonly inbox: { reports: number; feedback: number; submissions: number; contact: number };
  readonly activity: readonly {
    action: string;
    entityType: string;
    entityId: string;
    createdAt: string;
  }[];
  readonly zeroResults: readonly { query: string; rawQuery: string; hits: number }[];
}

export interface InboxItem {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly title: string;
  readonly detail: string | null;
  readonly videoId: string | null;
  readonly contactEmail: string | null;
  readonly adminNote: string;
}

export type InboxName = 'reports' | 'feedback' | 'submissions' | 'contact';

export interface VideoPatch {
  readonly title?: string;
  readonly categoryId?: string;
  readonly status?: VideoStatus;
  readonly isFeatured?: boolean;
  readonly isHebrew?: boolean;
  readonly adminNote?: string;
}

/**
 * The admin repository does not reuse `HttpClient`: every request here needs an
 * `Authorization` header and none of them should be retried, cached or shared
 * with the public client. Keeping the two apart means a public page can never
 * accidentally send the staff token.
 */
export class AdminRepository {
  /** The token currently in use, or `null`. */
  token(): string | null {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  setToken(token: string): void {
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Storage blocked: the token lives for this page load only.
    }
  }

  clearToken(): void {
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to do */
    }
  }

  /** Verify a token by asking the API who it belongs to. */
  session(): Promise<{ displayName: string; roles: readonly string[] }> {
    return this.#get('/admin/session');
  }

  overview(): Promise<AdminOverview> {
    return this.#get('/admin/overview');
  }

  listVideos(params: Record<string, string | number>): Promise<PagedResult<AdminVideo>> {
    return this.#getPage<AdminVideo>('/admin/videos', params);
  }

  updateVideo(id: string, patch: VideoPatch): Promise<{ id: string }> {
    return this.#send(`/admin/videos/${id}`, 'PATCH', patch);
  }

  bulkUpdate(ids: readonly string[], patch: VideoPatch): Promise<{ changed: number }> {
    return this.#send('/admin/videos/bulk', 'POST', { ids, patch });
  }

  bulkTag(
    ids: readonly string[],
    tag: string,
    mode: 'add' | 'remove',
  ): Promise<{ changed: number }> {
    return this.#send(`/admin/videos/tags?mode=${mode}`, 'POST', { ids, tag });
  }

  deleteVideos(ids: readonly string[], restore = false): Promise<{ changed: number }> {
    return this.#send(`/admin/videos/delete?mode=${restore ? 'restore' : 'delete'}`, 'POST', {
      ids,
    });
  }

  listInbox(name: InboxName, status = 'all', page = 1): Promise<PagedResult<InboxItem>> {
    return this.#getPage(`/admin/inbox/${name}`, { status, page });
  }

  updateInboxItem(
    name: InboxName,
    id: string,
    status: string,
    adminNote = '',
  ): Promise<{ id: string }> {
    return this.#send(`/admin/inbox/${name}/${id}`, 'PATCH', { status, adminNote });
  }

  // --------------------------------------------------------- Maintenance

  maintenance(): Promise<MaintenanceStatus> {
    return this.#get('/admin/maintenance');
  }

  runMaintenance(): Promise<{ checked: number; broken: number; recovered: number }> {
    return this.#send('/admin/maintenance/run', 'POST', {});
  }

  resources(): Promise<ResourceStatus> {
    return this.#get('/admin/resources');
  }

  // ------------------------------------------------------------- Imports

  listImports(): Promise<readonly ImportJob[]> {
    return this.#get('/admin/imports');
  }

  importReport(id: string): Promise<{ job: ImportJob; errors: readonly ImportRowError[] }> {
    return this.#get(`/admin/imports/${id}`);
  }

  createImport(input: {
    filename: string;
    format: 'csv' | 'xlsx' | 'json' | 'youtube-urls';
    totalRows: number;
    mapping: unknown;
  }): Promise<{ id: string; batchSize: number }> {
    return this.#send('/admin/imports', 'POST', input);
  }

  importRows(
    id: string,
    payload: {
      rows: readonly { rowNumber: number; values: Record<string, string> }[];
      mapping: unknown;
      options: ImportOptions;
    },
  ): Promise<{
    imported: number;
    updated: number;
    duplicates: number;
    failed: number;
    rejected: number;
  }> {
    return this.#send(`/admin/imports/${id}/rows`, 'POST', payload);
  }

  completeImport(id: string, status: 'completed' | 'failed', message = ''): Promise<ImportJob> {
    return this.#send(`/admin/imports/${id}/complete`, 'POST', { status, message });
  }

  searchInsights(days = 30): Promise<{
    zeroResults: readonly { query: string; rawQuery: string; hits: number }[];
    popular: readonly { query: string; hits: number; averageResults: number }[];
  }> {
    return this.#get(`/admin/search-insights?days=${String(days)}`);
  }

  // ---------------------------------------------------------------- Plumbing

  #headers(): Record<string, string> {
    const token = this.token();
    return token == null ? {} : { authorization: `Bearer ${token}` };
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(`/api${path}`, { headers: this.#headers() });
    return unwrap<T>(response);
  }

  async #getPage<T>(
    path: string,
    params: Record<string, string | number>,
  ): Promise<PagedResult<T>> {
    const url = new URL(`/api${path}`, window.location.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const response = await fetch(url, { headers: this.#headers() });
    const body = (await response.json()) as {
      data: T[];
      meta: PageMeta;
      error: { message: string } | null;
    };
    if (body.error != null) throw new Error(body.error.message);
    return { items: body.data, meta: body.meta };
  }

  async #send<T>(path: string, method: string, body: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      headers: { ...this.#headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return unwrap<T>(response);
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json()) as {
    data: T;
    error: { message: string; code: string } | null;
  };
  if (body.error != null) {
    const error = new Error(body.error.message);
    error.name = body.error.code;
    throw error;
  }
  return body.data;
}

export const adminApi = new AdminRepository();
