import { z } from 'zod';
import {
  compareRows,
  metricChange,
  topByCurrentClicks,
  topGainers,
  topLosers,
  type ComparedRow,
  type MetricChange,
} from '../analysis/compare.js';
import {
  COMPARE_MODES,
  comparisonRange,
  earliestAvailableDate,
  todayPT,
  type CompareMode,
  type DateRange,
} from '../dates.js';
import { UserFacingError } from '../errors.js';
import {
  compactUrl,
  fmtChange,
  fmtInt,
  fmtPct,
  fmtPos,
  fmtSigned,
  mdTable,
  sections,
  toMetrics,
  type Metrics,
} from '../format.js';
import {
  dateRangeFields,
  displayHost,
  fetchKeyed,
  fetchTotals,
  filtersField,
  limitField,
  propertyFor,
  resolveWindow,
  searchTypeField,
  siteUrlField,
} from './common.js';
import { defineTool, READ_ONLY } from './types.js';

export const COMPARE_DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
  'none',
] as const;
export const COMPARE_VIEWS = ['movers', 'top', 'all'] as const;

export interface ComparePeriodsResult {
  site_url: string;
  dimension: (typeof COMPARE_DIMENSIONS)[number];
  compare_to: CompareMode;
  current: DateRange;
  previous: DateRange;
  data_state: 'final' | 'all';
  totals: { current: Metrics; previous: Metrics; change: MetricChange };
  /** Top rows by current-period clicks, with deltas (view = top | all). */
  top: ComparedRow[];
  gainers: ComparedRow[];
  losers: ComparedRow[];
  new_count: number;
  lost_count: number;
  compared_count: number;
  truncated: boolean;
}

export const comparePeriods = defineTool({
  name: 'compare_periods',
  title: 'Compare periods (gainers & losers)',
  description:
    'Compares a period with the previous period or the same dates last year: property totals with deltas, plus the top gaining and losing queries/pages/countries/devices by clicks. ' +
    'Use for "what changed?", traffic drops, and month-over-month or year-over-year reports. dimension "none" returns totals only.',
  input: z.object({
    site_url: siteUrlField,
    ...dateRangeFields,
    compare_to: z
      .enum(COMPARE_MODES)
      .default('previous_period')
      .describe(
        'previous_period (same length, right before) or year_over_year (same dates last year).',
      ),
    dimension: z.enum(COMPARE_DIMENSIONS).default('query'),
    view: z
      .enum(COMPARE_VIEWS)
      .default('movers')
      .describe('movers = top gainers + losers; top = biggest rows now with deltas; all = both.'),
    filters: filtersField,
    search_type: searchTypeField,
    limit: limitField(10, 100),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<ComparePeriodsResult> {
    const property = await propertyFor(ctx, input.site_url);
    const current = await resolveWindow(ctx, property, input, input.search_type);
    const previous = comparisonRange(current, input.compare_to);
    const earliest = earliestAvailableDate(todayPT(ctx.now()));
    if (previous.startDate < earliest) {
      throw new UserFacingError(
        `The comparison period would start ${previous.startDate}, but Search Console only keeps ~16 months of data (earliest ≈ ${earliest}). Use a shorter date_range or compare_to "previous_period".`,
      );
    }
    const opts = { type: input.search_type, filters: input.filters, dataState: current.dataState };
    const dimension = input.dimension === 'none' ? null : input.dimension;
    const [curTotals, prevTotals, curRows, prevRows] = await Promise.all([
      fetchTotals(ctx, property.site_url, current, opts),
      fetchTotals(ctx, property.site_url, previous, opts),
      dimension ? fetchKeyed(ctx, property.site_url, current, dimension, opts) : null,
      dimension ? fetchKeyed(ctx, property.site_url, previous, dimension, opts) : null,
    ]);
    const rows = curRows && prevRows ? compareRows(curRows.rows, prevRows.rows) : [];
    const cur = toMetrics(curTotals);
    const prev = toMetrics(prevTotals);
    const wantTop = input.view !== 'movers';
    const wantMovers = input.view !== 'top';
    return {
      site_url: property.site_url,
      dimension: input.dimension,
      compare_to: input.compare_to,
      current: { startDate: current.startDate, endDate: current.endDate },
      previous,
      data_state: current.dataState,
      totals: { current: cur, previous: prev, change: metricChange(cur, prev) },
      top: wantTop ? topByCurrentClicks(rows, input.limit) : [],
      gainers: wantMovers ? topGainers(rows, input.limit) : [],
      losers: wantMovers ? topLosers(rows, input.limit) : [],
      new_count: rows.filter((r) => r.status === 'new').length,
      lost_count: rows.filter((r) => r.status === 'lost').length,
      compared_count: rows.length,
      truncated: Boolean(curRows?.truncated || prevRows?.truncated),
    };
  },
  format(r) {
    const t = r.totals;
    const host = displayHost(r.site_url);
    const label = (key: string) => (r.dimension === 'page' ? compactUrl(key, host) : key);
    const totals = mdTable(
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
          `${fmtSigned(t.change.ctr_pp, (v) => v.toFixed(2))} pp`,
        ],
        [
          'Avg position',
          fmtPos(t.current.position),
          fmtPos(t.previous.position),
          positionChange(t.change.rank_improvement),
        ],
      ],
    );
    const table = (title: string, rows: ComparedRow[]) =>
      rows.length === 0
        ? null
        : sections(
            `**${title}**`,
            mdTable(
              [r.dimension, 'Clicks', 'Δ clicks', 'Impr.', 'Δ impr.', 'Pos.', 'Δ pos.'],
              rows.map((row) => [
                label(row.key),
                fmtInt(row.current.clicks),
                fmtChange(row.current.clicks, row.previous.clicks),
                fmtInt(row.current.impressions),
                fmtSigned(row.change.impressions),
                fmtPos(row.current.position),
                positionChange(row.change.rank_improvement),
              ]),
            ),
          );
    return sections(
      `**${r.site_url}: ${r.current.startDate} → ${r.current.endDate} vs ${r.previous.startDate} → ${r.previous.endDate}** (${r.compare_to === 'year_over_year' ? 'year over year' : 'previous period'}, ${r.data_state} data)`,
      totals,
      table(`Top ${r.dimension} values now`, r.top),
      table('Top gainers (by clicks)', r.gainers),
      table('Top losers (by clicks)', r.losers),
      r.dimension !== 'none'
        ? `_${fmtInt(r.compared_count)} ${r.dimension} values compared: ${fmtInt(r.new_count)} new, ${fmtInt(r.lost_count)} no longer appearing.${r.truncated ? ' Row cap reached; the long tail is not included.' : ''}_`
        : null,
    );
  },
});

export function positionChange(improvement: number | null): string {
  if (improvement === null) return '–';
  if (improvement === 0) return '0';
  return improvement > 0 ? `↑${improvement.toFixed(1)}` : `↓${Math.abs(improvement).toFixed(1)}`;
}
