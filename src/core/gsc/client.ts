import { LruCache } from '../cache.js';
import { GscApiError, toGscApiError } from '../errors.js';
import type { Logger } from '../log.js';
import type { TokenSource } from './auth.js';
import type {
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  SearchAnalyticsRow,
  SiteEntry,
  Sitemap,
  UrlInspectionResponse,
} from './types.js';

export const API_BASE = 'https://searchconsole.googleapis.com';
const WEBMASTERS = `${API_BASE}/webmasters/v3`;
const INSPECT_URL = `${API_BASE}/v1/urlInspection/index:inspect`;

/** Google's maximum page size for searchanalytics.query. */
export const PAGE_SIZE = 25_000;

/** Response cache; keys are scoped by identity, so users never see each other's data. */
export type ResponseCache = LruCache<unknown>;

/** Weight budget is in rows, which keeps memory bounded on small runtimes (Workers: 128 MB). */
export function createResponseCache(): ResponseCache {
  return new LruCache<unknown>({ maxEntries: 300, maxWeight: 60_000 });
}

export interface GscClientOptions {
  tokenSource: TokenSource;
  logger: Logger;
  fetch?: typeof fetch;
  cache?: ResponseCache;
  cacheTtlMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  siteUrl?: string;
  /** Cache weight; omit to skip caching. */
  cacheWeight?: (data: unknown) => number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class GscClient {
  private readonly tokenSource: TokenSource;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly cache?: ResponseCache;
  private readonly cacheTtlMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GscClientOptions) {
    this.tokenSource = opts.tokenSource;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.cache = opts.cache;
    this.cacheTtlMs = opts.cacheTtlMs ?? 300_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get identity() {
    return this.tokenSource.identity;
  }

  get canWrite(): boolean {
    return this.tokenSource.scopes.includes('https://www.googleapis.com/auth/webmasters');
  }

  async listSites(): Promise<SiteEntry[]> {
    const data = await this.request<{ siteEntry?: SiteEntry[] }>({
      method: 'GET',
      url: `${WEBMASTERS}/sites`,
      cacheWeight: () => 1,
    });
    return data.siteEntry ?? [];
  }

  async searchAnalytics(
    siteUrl: string,
    body: SearchAnalyticsRequest,
  ): Promise<SearchAnalyticsResponse> {
    return this.request<SearchAnalyticsResponse>({
      method: 'POST',
      url: `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      body,
      siteUrl,
      cacheWeight: (d) => Math.max(1, (d as SearchAnalyticsResponse).rows?.length ?? 0),
    });
  }

  /**
   * Fetches up to `maxRows` rows, paging through `startRow` in 25,000-row pages. Google exposes at
   * most ~50K rows per day per search type, so very large sites may still be truncated upstream.
   */
  async searchAnalyticsAll(
    siteUrl: string,
    body: Omit<SearchAnalyticsRequest, 'rowLimit' | 'startRow'>,
    maxRows: number,
  ): Promise<{
    rows: SearchAnalyticsRow[];
    truncated: boolean;
    metadata?: SearchAnalyticsResponse['metadata'];
  }> {
    const rows: SearchAnalyticsRow[] = [];
    let metadata: SearchAnalyticsResponse['metadata'];
    let startRow = 0;
    for (;;) {
      const rowLimit = Math.min(PAGE_SIZE, maxRows - rows.length);
      const res = await this.searchAnalytics(siteUrl, { ...body, rowLimit, startRow });
      metadata ??= res.metadata;
      const page = res.rows ?? [];
      rows.push(...page);
      if (page.length < rowLimit) return { rows, truncated: false, metadata };
      if (rows.length >= maxRows) return { rows, truncated: true, metadata };
      startRow += page.length;
    }
  }

  async inspectUrl(
    siteUrl: string,
    inspectionUrl: string,
    languageCode = 'en-US',
  ): Promise<UrlInspectionResponse> {
    return this.request<UrlInspectionResponse>({
      method: 'POST',
      url: INSPECT_URL,
      body: { inspectionUrl, siteUrl, languageCode },
      siteUrl,
      cacheWeight: () => 1,
    });
  }

  async listSitemaps(siteUrl: string, sitemapIndex?: string): Promise<Sitemap[]> {
    const query = sitemapIndex ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}` : '';
    const data = await this.request<{ sitemap?: Sitemap[] }>({
      method: 'GET',
      url: `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps${query}`,
      siteUrl,
      cacheWeight: () => 1,
    });
    return data.sitemap ?? [];
  }

  async getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap> {
    return this.request<Sitemap>({
      method: 'GET',
      url: `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      siteUrl,
      cacheWeight: () => 1,
    });
  }

  async submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
    await this.request({
      method: 'PUT',
      url: `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      siteUrl,
    });
    this.invalidateSite(siteUrl);
  }

  async deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      url: `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      siteUrl,
    });
    this.invalidateSite(siteUrl);
  }

  private cacheKey(opts: RequestOptions): string {
    return `${this.identity.email}\n${opts.method} ${opts.url}\n${opts.body ? JSON.stringify(opts.body) : ''}`;
  }

  private invalidateSite(siteUrl: string): void {
    const marker = encodeURIComponent(siteUrl);
    this.cache?.deleteWhere(
      (key) => key.startsWith(`${this.identity.email}\n`) && key.includes(marker),
    );
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const useCache = this.cache && opts.cacheWeight && this.cacheTtlMs > 0;
    const key = useCache ? this.cacheKey(opts) : '';
    if (useCache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) {
        this.logger.debug('gsc cache hit', { method: opts.method, path: pathOf(opts.url) });
        return hit as T;
      }
    }

    let refreshedToken = false;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        const token = await this.tokenSource.getAccessToken();
        res = await this.fetchImpl(opts.url, {
          method: opts.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error instanceof GscApiError) {
          if (error.retryable && attempt < this.maxRetries) {
            await this.sleep(backoff(attempt));
            continue;
          }
          throw error;
        }
        if (attempt < this.maxRetries) {
          this.logger.warn('gsc network error, retrying', { attempt, error });
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new GscApiError({
          kind: 'network',
          status: 0,
          googleMessage: '',
          retryable: true,
          advice:
            'Could not reach the Google Search Console API (network error or timeout). Try again shortly.',
        });
      }

      this.logger.debug('gsc request', {
        method: opts.method,
        path: pathOf(opts.url),
        status: res.status,
        ms: Date.now() - started,
      });

      if (res.ok) {
        const text = await res.text();
        const data = (text ? JSON.parse(text) : {}) as T;
        if (useCache) this.cache.set(key, data, this.cacheTtlMs, opts.cacheWeight!(data));
        return data;
      }

      const body: unknown = await res.json().catch(() => undefined);
      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.tokenSource.invalidate();
        continue;
      }
      const error = toGscApiError(res.status, body, {
        identity: this.identity,
        siteUrl: opts.siteUrl,
      });
      const retryable =
        RETRYABLE_STATUS.has(res.status) || (error.kind === 'rate_limited' && error.retryable);
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10_000)
            : backoff(attempt);
        this.logger.info('gsc retrying', { status: res.status, attempt, delay });
        await this.sleep(delay);
        continue;
      }
      throw error;
    }
  }
}

/** Exponential backoff with jitter: ~0.5s, 1s, 2s, 4s (+ up to 250ms). */
export function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

/** Path for logs, with the (possibly sensitive) site URL segment left encoded. */
function pathOf(url: string): string {
  return url.replace(API_BASE, '');
}
