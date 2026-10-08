// Typed client for the dashboard API. Tool results are typed straight from the server's tool
// definitions, so the dashboard renders exactly what the MCP tools return.
import type { comparePeriods } from '../../src/core/tools/compare.js';
import type { contentDecay } from '../../src/core/tools/content-decay.js';
import type { inspectUrl } from '../../src/core/tools/inspection.js';
import type {
  ctrOpportunities,
  keywordCannibalization,
  strikingDistanceKeywords,
} from '../../src/core/tools/opportunities.js';
import type { searchAnalytics } from '../../src/core/tools/search-analytics.js';
import type { listSites } from '../../src/core/tools/sites.js';
import type { listSitemaps } from '../../src/core/tools/sitemaps.js';
import type { ActivityEntry } from '../../src/core/activity.js';
import type { Property } from '../../src/core/gsc/sites.js';

type ResultOf<T> = T extends { run(...args: never[]): Promise<infer R> } ? R : never;

export interface ToolResults {
  list_sites: ResultOf<typeof listSites>;
  search_analytics: ResultOf<typeof searchAnalytics>;
  compare_periods: ResultOf<typeof comparePeriods>;
  striking_distance_keywords: ResultOf<typeof strikingDistanceKeywords>;
  ctr_opportunities: ResultOf<typeof ctrOpportunities>;
  keyword_cannibalization: ResultOf<typeof keywordCannibalization>;
  content_decay: ResultOf<typeof contentDecay>;
  list_sitemaps: ResultOf<typeof listSitemaps>;
  inspect_url: ResultOf<typeof inspectUrl>;
}

export interface Status {
  version: string;
  latest_version: string | null;
  update_available: boolean;
  platform: string;
  auth_mode: string;
  identity: { kind: string; email: string; projectId?: string };
  writes_enabled: boolean;
  secret_path_enabled: boolean;
  public_base_url: string | null;
  rate_limit_per_minute: number;
  activity_persistent: boolean;
  /** Google OAuth mode only. */
  oauth: {
    redirect_uri: string;
    allowed_domains: string[];
    allowed_email_count: number;
    open_to_anyone: boolean;
  } | null;
  google:
    | { ok: true; latency_ms: number; properties: Property[] }
    | { ok: false; latency_ms: number; error: string; kind: string };
  warnings: string[];
}

export interface SessionInfo {
  authenticated: boolean;
  auth_mode: 'service_account' | 'oauth';
  /** How people sign in to the dashboard. */
  login: 'token' | 'google';
  email: string | null;
}

export interface ConnectInfo {
  base_url: string;
  mcp_url: string;
  auth_mode: string;
  secret_path_enabled: boolean;
}

export interface Activity {
  persistent: boolean;
  entries: ActivityEntry[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== '/api/session') onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (HTTP ${res.status}).`);
  return data as T;
}

export async function runTool<K extends keyof ToolResults>(
  name: K,
  input: Record<string, unknown>,
): Promise<ToolResults[K]> {
  const { result } = await api<{ result: ToolResults[K] }>(`/api/tools/${name}`, { body: input });
  return result;
}
