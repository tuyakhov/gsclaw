import { z } from 'zod';
import { UserFacingError } from '../errors.js';
import {
  compactUrl,
  fmtInt,
  fmtPct,
  fmtPos,
  mdTable,
  omittedNote,
  sections,
  toMetrics,
  type Metrics,
} from '../format.js';
import {
  AGGREGATION_TYPES,
  DIMENSIONS,
  type Dimension,
  type SearchAnalyticsRequest,
} from '../gsc/types.js';
import {
  dateRangeFields,
  displayHost,
  filtersField,
  limitField,
  propertyFor,
  resolveWindow,
  searchTypeField,
  siteUrlField,
  toFilterGroups,
  windowNote,
} from './common.js';
import { defineTool, READ_ONLY } from './types.js';

const SORT_KEYS = ['clicks', 'impressions', 'ctr', 'position'] as const;

export interface AnalyticsRow extends Metrics {
  keys: Partial<Record<Dimension, string>>;
}

export interface SearchAnalyticsResult {
  site_url: string;
  start_date: string;
  end_date: string;
  data_state: string;
  search_type: string;
  dimensions: Dimension[];
  totals: Metrics | null;
  rows: AnalyticsRow[];
  total_rows: number;
  /** True when the row cap was reached and more rows may exist. */
  truncated: boolean;
  first_incomplete_date?: string;
}

export const searchAnalytics = defineTool({
  name: 'search_analytics',
  title: 'Search performance (raw query)',
  description:
    'Queries Search Console performance data (clicks, impressions, CTR, average position) grouped by any dimensions, with filters (equals, contains, regex…), search type and aggregation type. Auto-paginates up to row_limit. ' +
    'Use for custom breakdowns; prefer the analysis tools (compare_periods, striking_distance_keywords, …) for common questions. ' +
    'Note: the API exposes only top rows (max ~50K/day/search type), and anonymized rare queries are omitted from query rows but included in totals.',
  input: z.object({
    site_url: siteUrlField,
    ...dateRangeFields,
    dimensions: z
      .array(z.enum(DIMENSIONS))
      .max(5)
      .default(['query'])
      .describe(
        'Group by. searchAppearance cannot be combined with other dimensions. hour requires recent dates (last ~10 days) and switches to hourly data. Use [] for property totals.',
      ),
    filters: filtersField,
    search_type: searchTypeField,
    aggregation_type: z
      .enum(AGGREGATION_TYPES)
      .default('auto')
      .describe(
        'auto (default), byPage, byProperty (not with page dimension/filter), byNewsShowcasePanel.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(500_000)
      .default(1000)
      .describe(
        'Rows to fetch from Google (auto-paginated in 25K pages; capped by the server’s GSCLAW_MAX_ROWS).',
      ),
    order_by: z
      .enum(SORT_KEYS)
      .default('clicks')
      .describe('Sort shown rows by this metric (position sorts ascending).'),
    limit: limitField(25),
    include_totals: z
      .boolean()
      .default(true)
      .describe('Also fetch property totals for the same filters (one extra request).'),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<SearchAnalyticsResult> {
    if (input.dimensions.includes('searchAppearance') && input.dimensions.length > 1) {
      throw new UserFacingError(
        'searchAppearance cannot be combined with other dimensions. Query searchAppearance alone first, then filter on one appearance and group by other dimensions.',
      );
    }
    const property = await propertyFor(ctx, input.site_url);
    const window = await resolveWindow(ctx, property, input, input.search_type);
    const hourly = input.dimensions.includes('hour');
    const base: Omit<SearchAnalyticsRequest, 'rowLimit' | 'startRow'> = {
      startDate: window.startDate,
      endDate: window.endDate,
      type: input.search_type,
      dimensionFilterGroups: toFilterGroups(input.filters),
      aggregationType: input.aggregation_type,
      dataState: hourly ? 'hourly_all' : window.dataState,
    };

    const maxRows = Math.min(input.row_limit, ctx.config.maxRows);
    const [result, totalsRes] = await Promise.all([
      input.dimensions.length > 0
        ? ctx.gsc.searchAnalyticsAll(
            property.site_url,
            { ...base, dimensions: input.dimensions },
            maxRows,
          )
        : Promise.resolve(null),
      input.include_totals || input.dimensions.length === 0
        ? ctx.gsc.searchAnalytics(property.site_url, {
            ...base,
            // Google only accepts the hourly data state when grouping by hour; totals have no
            // dimensions, so ask for the same days with all (fresh) data instead.
            dataState: hourly ? 'all' : base.dataState,
            rowLimit: 1,
          })
        : Promise.resolve(null),
    ]);

    const rows: AnalyticsRow[] = (result?.rows ?? []).map((r) => ({
      keys: Object.fromEntries(input.dimensions.map((d, i) => [d, r.keys?.[i] ?? ''])),
      ...toMetrics(r),
    }));
    sortRows(rows, input.order_by);

    const totalRow = totalsRes?.rows?.[0];
    const meta = result?.metadata ?? totalsRes?.metadata;
    return {
      site_url: property.site_url,
      start_date: window.startDate,
      end_date: window.endDate,
      data_state: base.dataState ?? 'final',
      search_type: input.search_type,
      dimensions: input.dimensions,
      totals: totalRow
        ? toMetrics(totalRow)
        : totalsRes
          ? toMetrics({ clicks: 0, impressions: 0 })
          : null,
      rows: rows.slice(0, input.limit),
      total_rows: rows.length,
      truncated: result?.truncated ?? false,
      first_incomplete_date: meta?.first_incomplete_date ?? meta?.firstIncompleteDate,
    };
  },
  format(r) {
    const host = displayHost(r.site_url);
    const totals = r.totals
      ? `**Totals:** ${fmtInt(r.totals.clicks)} clicks · ${fmtInt(r.totals.impressions)} impressions · CTR ${fmtPct(r.totals.ctr_pct)} · avg position ${fmtPos(r.totals.position)}`
      : null;
    const table =
      r.dimensions.length > 0
        ? mdTable(
            [...r.dimensions, 'Clicks', 'Impr.', 'CTR', 'Pos.'],
            r.rows.map((row) => [
              ...r.dimensions.map((d) =>
                d === 'page' ? compactUrl(row.keys[d] ?? '', host) : row.keys[d],
              ),
              fmtInt(row.clicks),
              fmtInt(row.impressions),
              fmtPct(row.ctr_pct),
              fmtPos(row.position),
            ]),
          )
        : null;
    return sections(
      `**Search analytics** for ${r.site_url} (${r.search_type}${r.dimensions.length ? `, by ${r.dimensions.join(' × ')}` : ''})`,
      windowNote({
        startDate: r.start_date,
        endDate: r.end_date,
        dataState: r.data_state === 'final' ? 'final' : 'all',
        label: '',
      }),
      totals,
      table,
      omittedNote(r.rows.length, r.total_rows, 'Raise `limit` to see more, or add filters.'),
      r.truncated
        ? `_Row cap reached (${fmtInt(r.total_rows)} rows fetched); more rows may exist. Raise row_limit or narrow filters/dates._`
        : null,
      r.first_incomplete_date
        ? `_Data from ${r.first_incomplete_date} onward is incomplete._`
        : null,
    );
  },
});

function sortRows(rows: AnalyticsRow[], key: (typeof SORT_KEYS)[number]): void {
  const value = (r: AnalyticsRow) =>
    key === 'ctr' ? r.ctr_pct : key === 'position' ? -(r.position ?? Infinity) : r[key];
  rows.sort((a, b) => value(b) - value(a));
}
