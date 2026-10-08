// A small in-memory Search Console backend for tests. It answers the same REST endpoints GSClaw
// calls (token, sites, searchAnalytics.query with dimensions/filters/pagination, URL inspection,
// sitemaps) from a synthetic dataset, using the response shapes documented by Google.
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from '../../src/core/gsc/types.js';
import inspectionFixture from '../fixtures/url-inspection.json' with { type: 'json' };
import sitemapsFixture from '../fixtures/sitemaps.json' with { type: 'json' };
import sitesFixture from '../fixtures/sites.json' with { type: 'json' };

export const TEST_NOW = new Date('2026-10-08T19:00:00Z'); // 12:00 Pacific
export const LATEST_FINAL_DATE = '2026-10-05';
export const SITE = 'sc-domain:example.com';

export interface Fact {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  position: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface Series {
  query: string;
  page: string;
  impressions: number;
  position: number;
  ctr: number;
  /** Multiplier applied per day going back in time (decay: older days had more clicks). */
  trend?: (daysAgo: number) => number;
}

const P = 'https://example.com';

/** Designed so every analysis tool has something to find. */
export const SERIES: Series[] = [
  // Brand: top position, high CTR.
  { query: 'example', page: `${P}/`, impressions: 400, position: 1.1, ctr: 0.45 },
  // Striking distance: position ~12 with plenty of impressions.
  { query: 'giveaway picker', page: `${P}/pricing`, impressions: 120, position: 12.3, ctr: 0.008 },
  {
    query: 'free raffle tool',
    page: `${P}/tools/raffle`,
    impressions: 60,
    position: 9.4,
    ctr: 0.02,
  },
  // CTR opportunity: ranks #3 but CTR far below expectation.
  {
    query: 'instagram giveaway',
    page: `${P}/instagram`,
    impressions: 300,
    position: 3.1,
    ctr: 0.012,
  },
  // Cannibalization: two pages split the query.
  {
    query: 'random name picker',
    page: `${P}/tools/name-picker`,
    impressions: 150,
    position: 6.2,
    ctr: 0.05,
  },
  {
    query: 'random name picker',
    page: `${P}/blog/name-picker`,
    impressions: 110,
    position: 8.8,
    ctr: 0.02,
  },
  // Content decay: clicks shrink steadily towards today.
  {
    query: 'how to pick a winner',
    page: `${P}/blog/old-post`,
    impressions: 200,
    position: 4.5,
    ctr: 0.08,
    trend: (daysAgo) => 0.35 + daysAgo / 110,
  },
  // Filler rows so the site CTR curve has samples at most positions.
  ...Array.from({ length: 60 }, (_, i) => {
    const position = 1 + (i % 15) + (i % 3) * 0.2;
    const expected = [
      0.3, 0.16, 0.11, 0.08, 0.06, 0.045, 0.035, 0.03, 0.025, 0.02, 0.015, 0.012, 0.01, 0.009,
      0.008,
    ];
    return {
      query: `filler query ${i}`,
      page: `${P}/filler/${i % 12}`,
      impressions: 40 + (i % 7) * 10,
      position,
      ctr: expected[Math.min(14, Math.floor(position) - 1)]!,
    };
  }),
];

export function buildFacts(
  endDate = LATEST_FINAL_DATE,
  days = 200,
  opts: { series?: Series[]; shape?: (daysAgo: number, date: string, s: Series) => number } = {},
): Fact[] {
  const facts: Fact[] = [];
  for (let back = 0; back < days; back++) {
    const date = addDays(endDate, -back);
    for (const s of opts.series ?? SERIES) {
      const factor = (s.trend ? s.trend(back) : 1) * (opts.shape ? opts.shape(back, date, s) : 1);
      const impressions = Math.round(s.impressions * factor);
      facts.push({
        date,
        query: s.query,
        page: s.page,
        country: back % 3 === 0 ? 'gbr' : 'usa',
        device: back % 2 === 0 ? 'MOBILE' : 'DESKTOP',
        impressions,
        clicks: Math.round(impressions * s.ctr),
        position: s.position,
      });
    }
  }
  return facts;
}

function matches(
  fact: Fact,
  filters: NonNullable<SearchAnalyticsRequest['dimensionFilterGroups']>,
): boolean {
  return filters.every((group) =>
    group.filters.every((f) => {
      const value = String(fact[f.dimension as keyof Fact] ?? '');
      const expr = f.expression;
      switch (f.operator ?? 'equals') {
        case 'equals':
          return value === expr;
        case 'notEquals':
          return value !== expr;
        case 'contains':
          return value.toLowerCase().includes(expr.toLowerCase());
        case 'notContains':
          return !value.toLowerCase().includes(expr.toLowerCase());
        case 'includingRegex':
          return new RegExp(expr).test(value);
        case 'excludingRegex':
          return !new RegExp(expr).test(value);
      }
    }),
  );
}

export function aggregate(facts: Fact[], req: SearchAnalyticsRequest): SearchAnalyticsRow[] {
  const dims = req.dimensions ?? [];
  const groups = new Map<
    string,
    { keys: string[]; clicks: number; impressions: number; posWeighted: number }
  >();
  for (const fact of facts) {
    if (fact.date < req.startDate || fact.date > req.endDate) continue;
    if (req.dimensionFilterGroups && !matches(fact, req.dimensionFilterGroups)) continue;
    const keys = dims.map((d) => String(fact[d as keyof Fact]));
    const id = keys.join('\u0000');
    const g = groups.get(id) ?? { keys, clicks: 0, impressions: 0, posWeighted: 0 };
    g.clicks += fact.clicks;
    g.impressions += fact.impressions;
    g.posWeighted += fact.position * fact.impressions;
    groups.set(id, g);
  }
  const rows: SearchAnalyticsRow[] = [...groups.values()]
    .filter((g) => g.impressions > 0)
    .map((g) => ({
      ...(dims.length ? { keys: g.keys } : {}),
      clicks: g.clicks,
      impressions: g.impressions,
      ctr: g.clicks / g.impressions,
      position: g.posWeighted / g.impressions,
    }));
  if (dims[0] === 'date') rows.sort((a, b) => a.keys![0]!.localeCompare(b.keys![0]!));
  else rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const start = req.startRow ?? 0;
  return rows.slice(start, start + (req.rowLimit ?? 1000));
}

export interface FakeGsc {
  fetch: typeof fetch;
  calls: { method: string; url: string; body?: unknown; auth?: string }[];
  /** Queue a raw response for the next request whose URL contains `match`. */
  failNext(match: string, status: number, body: unknown, times?: number): void;
  facts: Fact[];
}

export function createFakeGsc(opts: { facts?: Fact[]; sites?: typeof sitesFixture } = {}): FakeGsc {
  const facts = opts.facts ?? buildFacts();
  const sites = opts.sites ?? sitesFixture;
  const calls: FakeGsc['calls'] = [];
  const failures: { match: string; status: number; body: unknown; times: number }[] = [];

  const respond = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown = rawBody;
    if (rawBody?.startsWith('{')) body = JSON.parse(rawBody);
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    calls.push({ method, url, body, auth });

    const failure = failures.find((f) => url.includes(f.match));
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) failures.splice(failures.indexOf(failure), 1);
      return respond(failure.body, failure.status);
    }

    if (url === 'https://oauth2.googleapis.com/token') {
      return respond({ access_token: 'ya29.test-token', expires_in: 3599, token_type: 'Bearer' });
    }
    const path = url.replace('https://searchconsole.googleapis.com', '');
    if (path === '/webmasters/v3/sites') return respond(sites);
    if (path.endsWith('/searchAnalytics/query')) {
      const siteUrl = decodeURIComponent(path.split('/')[4]!);
      const known = sites.siteEntry.find(
        (s) => s.siteUrl === siteUrl && s.permissionLevel !== 'siteUnverifiedUser',
      );
      if (!known) {
        return respond(
          {
            error: {
              code: 403,
              message: `User does not have sufficient permission for site '${siteUrl}'. See also: https://support.google.com/webmasters/answer/2451999.`,
              status: 'PERMISSION_DENIED',
              errors: [{ reason: 'forbidden', domain: 'global', message: 'forbidden' }],
            },
          },
          403,
        );
      }
      const rows = aggregate(facts, body as SearchAnalyticsRequest);
      return respond({ ...(rows.length ? { rows } : {}), responseAggregationType: 'byProperty' });
    }
    if (path === '/v1/urlInspection/index:inspect') {
      const req = body as { inspectionUrl: string };
      const result = structuredClone(inspectionFixture);
      result.inspectionResult.indexStatusResult.userCanonical = req.inspectionUrl;
      return respond(result);
    }
    if (/\/sitemaps\/[^/]+$/.test(path)) {
      if (method === 'PUT' || method === 'DELETE') return respond(undefined, 204);
      const feed = decodeURIComponent(path.split('/').at(-1)!);
      const sitemap = sitemapsFixture.sitemap.find((s) => s.path === feed);
      return sitemap
        ? respond(sitemap)
        : respond(
            { error: { code: 404, message: 'Sitemap not found.', status: 'NOT_FOUND' } },
            404,
          );
    }
    if (path.includes('/sitemaps')) return respond(sitemapsFixture);
    return respond({ error: { code: 404, message: `Unhandled fake path ${path}` } }, 404);
  };

  return {
    fetch: impl,
    calls,
    facts,
    failNext(match, status, body, times = 1) {
      failures.push({ match, status, body, times });
    },
  };
}
