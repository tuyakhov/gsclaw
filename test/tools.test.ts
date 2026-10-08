import { describe, expect, it } from 'vitest';
import { buildCtrCurve, expectedCtr, INDUSTRY_CTR_CURVE } from '../src/core/analysis/ctr-curve.js';
import { findContentDecay } from '../src/core/analysis/decay.js';
import { comparePeriods } from '../src/core/tools/compare.js';
import { contentDecay } from '../src/core/tools/content-decay.js';
import { batchInspectUrls, inspectUrl } from '../src/core/tools/inspection.js';
import {
  ctrOpportunities,
  keywordCannibalization,
  strikingDistanceKeywords,
} from '../src/core/tools/opportunities.js';
import { pageReport } from '../src/core/tools/page-report.js';
import { availableTools } from '../src/core/tools/registry.js';
import { searchAnalytics } from '../src/core/tools/search-analytics.js';
import { listSites } from '../src/core/tools/sites.js';
import { listSitemaps, submitSitemap } from '../src/core/tools/sitemaps.js';
import type { AnyTool } from '../src/core/tools/types.js';
import { LATEST_FINAL_DATE, SITE } from './helpers/fake-gsc.js';
import { testRuntime } from './helpers/setup.js';

/** Runs a tool exactly as the MCP layer does: validate input, run, format. */
async function call(tool: AnyTool, args: Record<string, unknown>, runtime = testRuntime()) {
  const input = tool.input.parse(args);
  const result = await tool.run(runtime.ctx, input);
  return { result: result as never, text: tool.format(result, input), runtime };
}

describe('registry', () => {
  it('hides write tools unless enabled and writable', () => {
    const names = (allowWrites: boolean, canWrite: boolean) =>
      availableTools({ allowWrites, canWrite }).map((t) => t.name);
    expect(names(false, true)).not.toContain('submit_sitemap');
    expect(names(true, false)).not.toContain('delete_sitemap');
    expect(names(true, true)).toEqual(expect.arrayContaining(['submit_sitemap', 'delete_sitemap']));
  });

  it('annotates every tool', () => {
    for (const tool of availableTools({ allowWrites: true, canWrite: true })) {
      expect(tool.title).toBeTruthy();
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.annotations.readOnlyHint).toBe(!tool.write);
      if (tool.write) expect(tool.description).toMatch(/^MUTATES STATE/);
    }
  });
});

describe('list_sites', () => {
  it('normalizes properties and permissions', async () => {
    const { result, text } = await call(listSites, {});
    expect(result).toMatchObject({
      properties: expect.arrayContaining([
        {
          site_url: 'sc-domain:example.com',
          type: 'domain',
          host: 'example.com',
          permission_level: 'owner',
          has_access: true,
        },
        expect.objectContaining({ site_url: 'http://legacy.example.net/', has_access: false }),
      ]),
    });
    expect(text).toContain('unverified (no data)');
  });
});

describe('search_analytics', () => {
  it('ends relative ranges on the latest final date and reports totals', async () => {
    const { result, text } = await call(searchAnalytics, {
      site_url: 'example.com',
      dimensions: ['query'],
      limit: 3,
    });
    const r = result as {
      end_date: string;
      start_date: string;
      rows: unknown[];
      total_rows: number;
      totals: { clicks: number };
    };
    expect(r.end_date).toBe(LATEST_FINAL_DATE);
    expect(r.start_date).toBe('2026-09-08');
    expect(r.rows).toHaveLength(3);
    expect(r.total_rows).toBeGreaterThan(60);
    expect(r.totals.clicks).toBeGreaterThan(0);
    expect(text).toMatch(/more row\(s\) not shown \(3 of/);
  });

  it('applies filters and rejects searchAppearance combinations', async () => {
    const { result } = await call(searchAnalytics, {
      site_url: SITE,
      dimensions: ['page'],
      filters: [{ dimension: 'query', operator: 'equals', expression: 'random name picker' }],
    });
    expect((result as { rows: unknown[] }).rows).toHaveLength(2);
    await expect(
      call(searchAnalytics, { site_url: SITE, dimensions: ['searchAppearance', 'query'] }),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('uses fresh data when asked', async () => {
    const { result, runtime } = await call(searchAnalytics, {
      site_url: SITE,
      fresh: true,
      dimensions: [],
    });
    expect((result as { end_date: string }).end_date).toBe('2026-10-08');
    expect(runtime.fake.calls.at(-1)!.body).toMatchObject({ dataState: 'all' });
  });
});

describe('analysis tools', () => {
  it('finds striking-distance keywords with potential clicks', async () => {
    const { result, text } = await call(strikingDistanceKeywords, { site_url: SITE });
    const rows = (
      result as { rows: { query: string; page: string; potential_extra_clicks: number }[] }
    ).rows;
    const picker = rows.find((r) => r.query === 'giveaway picker');
    expect(picker).toMatchObject({ page: 'https://example.com/pricing' });
    expect(picker!.potential_extra_clicks).toBeGreaterThan(0);
    expect(rows.find((r) => r.query === 'example')).toBeUndefined();
    expect(text).toContain('giveaway picker');
  });

  it('finds CTR opportunities and returns the benchmark curve', async () => {
    const { result } = await call(ctrOpportunities, { site_url: SITE });
    const r = result as {
      rows: { key: string; missed_clicks: number }[];
      curve: { position: number }[];
    };
    expect(r.rows[0]!.key).toBe('instagram giveaway');
    expect(r.rows[0]!.missed_clicks).toBeGreaterThan(100);
    expect(r.curve.length).toBeGreaterThanOrEqual(10);
  });

  it('finds keyword cannibalization with page shares', async () => {
    const { result } = await call(keywordCannibalization, { site_url: SITE });
    const r = result as { rows: { query: string; pages: { share_pct: number }[] }[] };
    expect(r.rows[0]!.query).toBe('random name picker');
    expect(r.rows[0]!.pages.map((p) => p.share_pct)).toEqual([57.7, 42.3]);
  });

  it('compares periods with gainers and losers', async () => {
    const { result, text } = await call(comparePeriods, {
      site_url: SITE,
      dimension: 'query',
      view: 'all',
    });
    const r = result as {
      losers: { key: string }[];
      previous: { endDate: string };
      current: { startDate: string };
    };
    expect(r.losers[0]!.key).toBe('how to pick a winner');
    expect(r.previous.endDate).toBe('2026-09-07');
    expect(text).toContain('Top losers');
  });

  it('refuses comparisons beyond the 16-month retention', async () => {
    await expect(
      call(comparePeriods, {
        site_url: SITE,
        date_range: 'last_6_months',
        compare_to: 'year_over_year',
      }),
    ).rejects.toThrow(/16 months/);
  });

  it('detects decaying content', async () => {
    const { result, text } = await call(contentDecay, { site_url: SITE });
    const r = result as { rows: { page: string; decline_pct: number; clicks: number[] }[] };
    expect(r.rows[0]!.page).toBe('https://example.com/blog/old-post');
    expect(r.rows[0]!.decline_pct).toBeGreaterThan(40);
    expect(text).toMatch(/decaying pages/);
  });

  it('builds a page report from a path', async () => {
    const { result, text } = await call(pageReport, { site_url: SITE, page: '/pricing' });
    const r = result as {
      page: string;
      trend: unknown[];
      top_queries: { key: string }[];
      inspection: { verdict: string };
    };
    expect(r.page).toBe('https://example.com/pricing');
    expect(r.trend).toHaveLength(28);
    expect(r.top_queries[0]!.key).toBe('giveaway picker');
    expect(r.inspection.verdict).toBe('PASS');
    expect(text).toContain('URL Inspection');
  });
});

describe('inspection and sitemaps', () => {
  it('summarizes URL inspection and infers the property', async () => {
    const { result, text } = await call(inspectUrl, {
      url: 'https://example.com/blog/name-picker',
    });
    expect(result).toMatchObject({
      site_url: 'sc-domain:example.com',
      verdict: 'PASS',
      canonical_mismatch: true,
      rich_results: {
        items: [{ type: 'FAQ', issues: ['WARNING: Missing field "acceptedAnswer"'] }],
      },
    });
    expect(text).toMatch(/mismatch/);
  });

  it('caps batch size', async () => {
    const urls = Array.from({ length: 60 }, (_, i) => `https://example.com/p${i}`);
    await expect(call(batchInspectUrls, { urls })).rejects.toThrow(/up to 50 per batch/);
    const { result } = await call(batchInspectUrls, { urls: urls.slice(0, 3) });
    expect(result).toMatchObject({ inspected: 3, failed: 0, canonical_mismatches: 3 });
  });

  it('parses int64 sitemap counters and explains the missing indexed count', async () => {
    const { result, text } = await call(listSitemaps, { site_url: SITE });
    expect(
      (result as { sitemaps: { submitted: number; errors: number }[] }).sitemaps[1],
    ).toMatchObject({ submitted: 267, errors: 2 });
    expect(text).toMatch(/no longer reports per-sitemap indexed counts/);
  });

  it('blocks sitemap submission for restricted users', async () => {
    const runtime = testRuntime({ env: { GSCLAW_ALLOW_WRITES: 'true' } });
    await expect(
      call(
        submitSitemap,
        {
          site_url: 'https://blog.example.org/',
          sitemap_url: 'https://blog.example.org/sitemap.xml',
        },
        runtime,
      ),
    ).rejects.toThrow(/Restricted users cannot submit/);
    const ok = await call(
      submitSitemap,
      { site_url: SITE, sitemap_url: 'https://example.com/sitemap.xml' },
      runtime,
    );
    expect(ok.runtime.fake.calls.at(-1)).toMatchObject({ method: 'PUT' });
  });
});

describe('analysis primitives', () => {
  it('falls back to the industry curve and stays non-increasing', () => {
    const curve = buildCtrCurve([], { benchmark: 'site' });
    expect(curve.map((p) => p.ctr_pct)).toEqual([...INDUSTRY_CTR_CURVE]);
    expect(expectedCtr(curve, 1.5)).toBeCloseTo(21, 5);
    const noisy = buildCtrCurve(
      Array.from({ length: 20 }, () => ({ clicks: 50, impressions: 100, position: 2 })),
      { benchmark: 'site' },
    );
    expect(noisy[1]).toMatchObject({ source: 'site', ctr_pct: 27 });
  });

  it('requires sustained decline for decay', () => {
    const series = new Map([
      [
        'steady',
        [
          { clicks: 100, impressions: 1000 },
          { clicks: 80, impressions: 900 },
          { clicks: 60, impressions: 800 },
          { clicks: 40, impressions: 700 },
        ],
      ],
      [
        'one-bad-window',
        [
          { clicks: 100, impressions: 1000 },
          { clicks: 120, impressions: 1000 },
          { clicks: 130, impressions: 1000 },
          { clicks: 50, impressions: 1000 },
        ],
      ],
    ]);
    const rows = findContentDecay(series, 4, { minBaselineClicks: 10, minDeclinePct: 20 });
    expect(rows.map((r) => r.page)).toEqual(['steady']);
  });
});
