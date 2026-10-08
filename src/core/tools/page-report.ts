import { z } from 'zod';
import {
  compareRows,
  metricChange,
  topByCurrentClicks,
  type ComparedRow,
  type MetricChange,
} from '../analysis/compare.js';
import { COMPARE_MODES, comparisonRange, type CompareMode, type DateRange } from '../dates.js';
import { publicErrorMessage, UserFacingError } from '../errors.js';
import {
  fmtChange,
  fmtInt,
  fmtPct,
  fmtPos,
  mdTable,
  sections,
  toMetrics,
  type Metrics,
} from '../format.js';
import { absolutePageUrl, type Property } from '../gsc/sites.js';
import type { DimensionFilter } from '../gsc/types.js';
import { positionChange } from './compare.js';
import {
  dateRangeFields,
  fetchKeyed,
  fetchRows,
  fetchTotals,
  limitField,
  propertyFor,
  resolveWindow,
  type ResolvedWindow,
} from './common.js';
import {
  formatInspection,
  inspectOne,
  propertyForUrl,
  type InspectionSummary,
} from './inspection.js';
import { defineTool, READ_ONLY, type ToolContext } from './types.js';

export interface PageReportResult {
  site_url: string;
  page: string;
  current: DateRange;
  previous: DateRange;
  compare_to: CompareMode;
  data_state: 'final' | 'all';
  totals: { current: Metrics; previous: Metrics; change: MetricChange };
  trend: ({ date: string } & Metrics)[];
  top_queries: ComparedRow[];
  query_count: number;
  inspection: InspectionSummary | null;
  inspection_error: string | null;
}

/** Turns a path like '/pricing' into the page URL Search Console reports, using the page's own data. */
async function resolvePageUrl(
  ctx: ToolContext,
  property: Property,
  page: string,
  window: ResolvedWindow,
): Promise<string> {
  const direct = absolutePageUrl(property, page);
  if (direct) return direct;
  if (!page.startsWith('/'))
    throw new UserFacingError(`'${page}' is not a URL or a path starting with '/'.`);
  const { rows } = await fetchRows(ctx, property.site_url, window, ['page'], {
    filters: [{ dimension: 'page', operator: 'contains', expression: page }],
    maxRows: 1000,
  });
  const candidates = rows
    .map((r) => ({ url: r.keys?.[0] ?? '', impressions: r.impressions }))
    .filter((c) => {
      try {
        return new URL(c.url).pathname === page;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.impressions - a.impressions);
  if (!candidates[0]) {
    throw new UserFacingError(
      `No page with path '${page}' has Search data on ${property.site_url} in this period. Pass the full URL (e.g. https://example.com${page}).`,
      'not_found',
    );
  }
  return candidates[0].url;
}

export const pageReport = defineTool({
  name: 'page_report',
  title: 'Page report',
  description:
    "One-call report for a single page: clicks/impressions/CTR/position vs the previous period, a daily trend, the page's top queries with deltas, and its URL Inspection status (index state, canonical, last crawl).",
  input: z.object({
    page: z
      .string()
      .min(1)
      .describe("Full page URL, or a path like '/pricing' (then site_url is required)."),
    site_url: z.string().optional().describe('Property. Optional when page is a full URL.'),
    ...dateRangeFields,
    compare_to: z.enum(COMPARE_MODES).default('previous_period'),
    top_queries: limitField(15, 100),
    include_inspection: z
      .boolean()
      .default(true)
      .describe('Also run URL Inspection (uses 1 of 2,000 daily inspections).'),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<PageReportResult> {
    let property: Property;
    if (/^https?:\/\//i.test(input.page))
      property = await propertyForUrl(ctx.gsc, input.page, input.site_url);
    else if (input.site_url) property = await propertyFor(ctx, input.site_url);
    else throw new UserFacingError('Pass site_url when page is a path.');

    const current = await resolveWindow(ctx, property, input);
    const previous = comparisonRange(current, input.compare_to);
    const pageUrl = await resolvePageUrl(ctx, property, input.page, current);
    const filters: DimensionFilter[] = [
      { dimension: 'page', operator: 'equals', expression: pageUrl },
    ];
    const opts = { filters, dataState: current.dataState };

    const inspection = input.include_inspection
      ? inspectOne(ctx, pageUrl, property.site_url).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({
            value: null,
            error: publicErrorMessage(error).message.split('\n')[0]!,
          }),
        )
      : Promise.resolve({ value: null, error: null });

    const [curTotals, prevTotals, trendRows, curQueries, prevQueries, inspected] =
      await Promise.all([
        fetchTotals(ctx, property.site_url, current, opts),
        fetchTotals(ctx, property.site_url, previous, opts),
        fetchRows(ctx, property.site_url, current, ['date'], opts),
        fetchKeyed(ctx, property.site_url, current, 'query', { ...opts, maxRows: 5000 }),
        fetchKeyed(ctx, property.site_url, previous, 'query', { ...opts, maxRows: 5000 }),
        inspection,
      ]);

    const cur = toMetrics(curTotals);
    const prev = toMetrics(prevTotals);
    const queries = compareRows(curQueries.rows, prevQueries.rows);
    return {
      site_url: property.site_url,
      page: pageUrl,
      current: { startDate: current.startDate, endDate: current.endDate },
      previous,
      compare_to: input.compare_to,
      data_state: current.dataState,
      totals: { current: cur, previous: prev, change: metricChange(cur, prev) },
      trend: trendRows.rows
        .map((r) => ({ date: r.keys?.[0] ?? '', ...toMetrics(r) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      top_queries: topByCurrentClicks(queries, input.top_queries),
      query_count: curQueries.rows.size,
      inspection: inspected.value,
      inspection_error: inspected.error,
    };
  },
  format(r) {
    const t = r.totals;
    const weekly = summarizeTrend(r.trend);
    return sections(
      `**Page report:** ${r.page}`,
      `_${r.current.startDate} → ${r.current.endDate} vs ${r.previous.startDate} → ${r.previous.endDate} (${r.compare_to === 'year_over_year' ? 'year over year' : 'previous period'}, ${r.data_state} data)._`,
      mdTable(
        ['Metric', 'Current', 'Previous', 'Change'],
        [
          [
            'Clicks',
            fmtInt(t.current.clicks),
            fmtInt(t.previous.clicks),
            fmtChange(t.current.clicks, t.previous.clicks),
          ],
          [
            'Impressions',
            fmtInt(t.current.impressions),
            fmtInt(t.previous.impressions),
            fmtChange(t.current.impressions, t.previous.impressions),
          ],
          [
            'CTR',
            fmtPct(t.current.ctr_pct),
            fmtPct(t.previous.ctr_pct),
            `${t.change.ctr_pp >= 0 ? '+' : ''}${t.change.ctr_pp.toFixed(2)} pp`,
          ],
          [
            'Avg position',
            fmtPos(t.current.position),
            fmtPos(t.previous.position),
            positionChange(t.change.rank_improvement),
          ],
        ],
      ),
      weekly ? `**Trend (clicks per 7 days, oldest → newest):** ${weekly}` : null,
      r.top_queries.length
        ? sections(
            `**Top queries** (${fmtInt(r.query_count)} total)`,
            mdTable(
              ['Query', 'Clicks', 'Δ clicks', 'Impr.', 'CTR', 'Pos.', 'Δ pos.'],
              r.top_queries.map((q) => [
                q.key,
                fmtInt(q.current.clicks),
                fmtChange(q.current.clicks, q.previous.clicks),
                fmtInt(q.current.impressions),
                fmtPct(q.current.ctr_pct),
                fmtPos(q.current.position),
                positionChange(q.change.rank_improvement),
              ]),
            ),
          )
        : '_No query data for this page in the period._',
      r.inspection
        ? formatInspection(r.inspection)
        : r.inspection_error
          ? `_URL Inspection failed: ${r.inspection_error}_`
          : null,
    );
  },
});

function summarizeTrend(trend: ({ date: string } & Metrics)[]): string | null {
  if (trend.length < 7) return trend.length ? trend.map((d) => fmtInt(d.clicks)).join(' → ') : null;
  const buckets: number[] = [];
  // Bucket from the newest day backwards so the last bucket is a full week.
  for (let end = trend.length; end > 0; end -= 7) {
    const slice = trend.slice(Math.max(0, end - 7), end);
    if (slice.length === 7) buckets.unshift(slice.reduce((s, d) => s + d.clicks, 0));
  }
  return buckets.map(fmtInt).join(' → ');
}
