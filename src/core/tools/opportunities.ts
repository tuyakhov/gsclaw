import { z } from 'zod';
import { buildCtrCurve, type CurvePoint } from '../analysis/ctr-curve.js';
import {
  findCannibalization,
  findCtrOpportunities,
  findStrikingDistance,
  type CannibalizationRow,
  type CtrOpportunityRow,
  type QueryPageRow,
  type StrikingDistanceRow,
} from '../analysis/opportunities.js';
import { compactUrl, fmtInt, fmtPct, fmtPos, mdTable, omittedNote, sections } from '../format.js';
import type { SearchAnalyticsRow } from '../gsc/types.js';
import {
  dateRangeFields,
  displayHost,
  excludeQueriesField,
  fetchRows,
  limitField,
  propertyFor,
  resolveWindow,
  siteUrlField,
  windowNote,
  withQueryExclusion,
  type ResolvedWindow,
} from './common.js';
import { defineTool, READ_ONLY, type ToolContext } from './types.js';

function toQueryPageRows(rows: SearchAnalyticsRow[]): QueryPageRow[] {
  return rows.map((r) => ({
    query: r.keys?.[0] ?? '',
    page: r.keys?.[1] ?? '',
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

async function queryPageRows(
  ctx: ToolContext,
  siteUrl: string,
  window: ResolvedWindow,
  excludeQueries?: string,
) {
  const { rows, truncated } = await fetchRows(ctx, siteUrl, window, ['query', 'page'], {
    filters: withQueryExclusion(undefined, excludeQueries),
    dataState: window.dataState,
  });
  return { rows: toQueryPageRows(rows), truncated };
}

const truncatedNote = (truncated: boolean) =>
  truncated
    ? '_Row cap reached: only the top rows by clicks were analysed (raise GSCLAW_MAX_ROWS or shorten the date range)._'
    : null;

// ---------------------------------------------------------------------------------------------

export interface StrikingDistanceResult {
  site_url: string;
  start_date: string;
  end_date: string;
  data_state: string;
  position_range: [number, number];
  min_impressions: number;
  target_position: number;
  expected_ctr_at_target_pct: number;
  total_matches: number;
  rows: StrikingDistanceRow[];
  truncated: boolean;
}

export const strikingDistanceKeywords = defineTool({
  name: 'striking_distance_keywords',
  title: 'Striking-distance keywords',
  description:
    'Finds queries ranking just off the top spots (default average position 8–20) with meaningful impressions: the cheapest wins in SEO. ' +
    'Returns the ranking page, position, impressions and an estimate of extra clicks if the page reached position 3 (based on the site’s own CTR curve).',
  input: z.object({
    site_url: siteUrlField,
    ...dateRangeFields,
    min_position: z.number().min(1).max(100).default(8),
    max_position: z.number().min(1).max(100).default(20),
    min_impressions: z
      .number()
      .int()
      .min(0)
      .default(20)
      .describe('Minimum impressions in the period.'),
    target_position: z
      .number()
      .min(1)
      .max(10)
      .default(3)
      .describe('Position used to estimate potential clicks.'),
    exclude_queries: excludeQueriesField,
    limit: limitField(25),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<StrikingDistanceResult> {
    const property = await propertyFor(ctx, input.site_url);
    const window = await resolveWindow(ctx, property, input);
    const [{ rows, truncated }, queryLevel] = await Promise.all([
      queryPageRows(ctx, property.site_url, window, input.exclude_queries),
      fetchRows(ctx, property.site_url, window, ['query'], {
        filters: withQueryExclusion(undefined, input.exclude_queries),
        dataState: window.dataState,
      }),
    ]);
    // The CTR curve comes from query-level rows, like ctr_opportunities. In query×page rows every
    // sitelink is its own ~0% CTR result at the top position, which drags the whole curve to zero.
    const curve = buildCtrCurve(queryLevel.rows, { benchmark: 'site' });
    const matches = findStrikingDistance(rows, {
      minPosition: input.min_position,
      maxPosition: input.max_position,
      minImpressions: input.min_impressions,
      targetPosition: input.target_position,
      curve,
    });
    return {
      site_url: property.site_url,
      start_date: window.startDate,
      end_date: window.endDate,
      data_state: window.dataState,
      position_range: [input.min_position, input.max_position],
      min_impressions: input.min_impressions,
      target_position: input.target_position,
      expected_ctr_at_target_pct: curve[Math.round(input.target_position) - 1]?.ctr_pct ?? 0,
      total_matches: matches.length,
      rows: matches.slice(0, input.limit),
      truncated,
    };
  },
  format(r) {
    const host = displayHost(r.site_url);
    if (r.total_matches === 0) {
      return `No striking-distance queries for ${r.site_url} (position ${r.position_range[0]}–${r.position_range[1]}, ≥${r.min_impressions} impressions, ${r.start_date} → ${r.end_date}). Try a longer date range or lower min_impressions.`;
    }
    return sections(
      `**${fmtInt(r.total_matches)} striking-distance queries** for ${r.site_url} (avg position ${r.position_range[0]}–${r.position_range[1]}, ≥${r.min_impressions} impressions)`,
      windowNote({
        startDate: r.start_date,
        endDate: r.end_date,
        dataState: r.data_state === 'all' ? 'all' : 'final',
        label: '',
      }),
      mdTable(
        [
          'Query',
          'Ranking page',
          'Pos.',
          'Impr.',
          'Clicks',
          'CTR',
          `+Clicks @#${r.target_position}`,
        ],
        r.rows.map((row) => [
          row.query,
          compactUrl(row.page, host) + (row.other_pages ? ` (+${row.other_pages} other)` : ''),
          fmtPos(row.position),
          fmtInt(row.impressions),
          fmtInt(row.clicks),
          fmtPct(row.ctr_pct),
          `+${fmtInt(row.potential_extra_clicks)}`,
        ]),
      ),
      omittedNote(r.rows.length, r.total_matches, 'Raise `limit` to see more.'),
      `_Potential clicks assume ${fmtPct(r.expected_ctr_at_target_pct)} CTR at position ${r.target_position} (your site's CTR curve where data allows, otherwise an industry average). "+N other" = more pages competing for the query; see keyword_cannibalization._`,
      truncatedNote(r.truncated),
    );
  },
});

// ---------------------------------------------------------------------------------------------

export interface CtrOpportunitiesResult {
  site_url: string;
  start_date: string;
  end_date: string;
  data_state: string;
  dimension: 'query' | 'page';
  benchmark: 'site' | 'industry';
  threshold_pct: number;
  min_impressions: number;
  max_position: number;
  curve: CurvePoint[];
  total_matches: number;
  rows: CtrOpportunityRow[];
  truncated: boolean;
}

export const ctrOpportunities = defineTool({
  name: 'ctr_opportunities',
  title: 'CTR opportunities',
  description:
    'Finds queries or pages with many impressions but a CTR well below what their position usually earns: candidates for better titles, meta descriptions and rich results. ' +
    'Compares against a CTR-by-position curve (the site’s own by default, falling back to an industry curve) and returns the curve used plus estimated missed clicks.',
  input: z.object({
    site_url: siteUrlField,
    ...dateRangeFields,
    dimension: z.enum(['query', 'page']).default('query'),
    max_position: z
      .number()
      .min(1)
      .max(20)
      .default(10)
      .describe('Only consider rows ranking at or above this average position.'),
    min_impressions: z.number().int().min(0).default(100),
    benchmark: z
      .enum(['site', 'industry'])
      .default('site')
      .describe(
        'site = your own median CTR per position (industry values fill gaps); industry = a generic curve from public CTR studies.',
      ),
    threshold_pct: z
      .number()
      .min(1)
      .max(100)
      .default(60)
      .describe('Flag rows whose CTR is below this % of the expected CTR (default 60%).'),
    exclude_queries: excludeQueriesField,
    limit: limitField(25),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<CtrOpportunitiesResult> {
    const property = await propertyFor(ctx, input.site_url);
    const window = await resolveWindow(ctx, property, input);
    const { rows, truncated } = await fetchRows(ctx, property.site_url, window, [input.dimension], {
      filters: withQueryExclusion(undefined, input.exclude_queries),
      dataState: window.dataState,
    });
    const keyed = rows.map((r) => ({ key: r.keys?.[0] ?? '', ...r }));
    const curve = buildCtrCurve(keyed, { benchmark: input.benchmark });
    const matches = findCtrOpportunities(keyed, {
      maxPosition: input.max_position,
      minImpressions: input.min_impressions,
      threshold: input.threshold_pct / 100,
      curve,
    });
    return {
      site_url: property.site_url,
      start_date: window.startDate,
      end_date: window.endDate,
      data_state: window.dataState,
      dimension: input.dimension,
      benchmark: input.benchmark,
      threshold_pct: input.threshold_pct,
      min_impressions: input.min_impressions,
      max_position: input.max_position,
      curve: curve.slice(0, Math.max(10, Math.ceil(input.max_position))),
      total_matches: matches.length,
      rows: matches.slice(0, input.limit),
      truncated,
    };
  },
  format(r) {
    const host = displayHost(r.site_url);
    const curve = r.curve
      .map((p) => `#${p.position}: ${fmtPct(p.ctr_pct)}${p.source === 'industry' ? '*' : ''}`)
      .join(' · ');
    if (r.total_matches === 0) {
      return sections(
        `No CTR opportunities for ${r.site_url}: no ${r.dimension} with ≥${r.min_impressions} impressions at position ≤${r.max_position} has a CTR below ${r.threshold_pct}% of the expected value.`,
        `_Benchmark curve: ${curve}_`,
      );
    }
    return sections(
      `**${fmtInt(r.total_matches)} ${r.dimension === 'query' ? 'queries' : 'pages'} with below-expected CTR** for ${r.site_url} (CTR < ${r.threshold_pct}% of the ${r.benchmark} benchmark for their position)`,
      windowNote({
        startDate: r.start_date,
        endDate: r.end_date,
        dataState: r.data_state === 'all' ? 'all' : 'final',
        label: '',
      }),
      mdTable(
        [
          r.dimension === 'page' ? 'Page' : 'Query',
          'Pos.',
          'Impr.',
          'Clicks',
          'CTR',
          'Expected',
          'Missed clicks',
        ],
        r.rows.map((row) => [
          r.dimension === 'page' ? compactUrl(row.key, host) : row.key,
          fmtPos(row.position),
          fmtInt(row.impressions),
          fmtInt(row.clicks),
          fmtPct(row.ctr_pct),
          fmtPct(row.expected_ctr_pct),
          fmtInt(row.missed_clicks),
        ]),
      ),
      omittedNote(r.rows.length, r.total_matches, 'Raise `limit` to see more.'),
      `_Benchmark CTR by position (${r.benchmark}; * = industry fallback): ${curve}. Branded queries inflate CTR at top positions; use exclude_queries for a non-brand view._`,
      truncatedNote(r.truncated),
    );
  },
});

// ---------------------------------------------------------------------------------------------

export interface CannibalizationResult {
  site_url: string;
  start_date: string;
  end_date: string;
  data_state: string;
  min_impressions: number;
  min_share_pct: number;
  total_matches: number;
  rows: CannibalizationRow[];
  truncated: boolean;
}

export const keywordCannibalization = defineTool({
  name: 'keyword_cannibalization',
  title: 'Keyword cannibalization',
  description:
    "Finds queries where two or more of the site's pages each get a meaningful share of impressions, so they compete with each other. Returns each page's impression share, clicks and position. URL #fragments are merged into their page.",
  input: z.object({
    site_url: siteUrlField,
    ...dateRangeFields,
    min_impressions: z
      .number()
      .int()
      .min(0)
      .default(50)
      .describe('Minimum total impressions for the query.'),
    min_share_pct: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'A page counts as competing if it has at least this share of the query’s impressions.',
      ),
    exclude_queries: excludeQueriesField,
    limit: limitField(20),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<CannibalizationResult> {
    const property = await propertyFor(ctx, input.site_url);
    const window = await resolveWindow(ctx, property, input);
    const { rows, truncated } = await queryPageRows(
      ctx,
      property.site_url,
      window,
      input.exclude_queries,
    );
    const matches = findCannibalization(rows, {
      minImpressions: input.min_impressions,
      minSharePct: input.min_share_pct,
    });
    return {
      site_url: property.site_url,
      start_date: window.startDate,
      end_date: window.endDate,
      data_state: window.dataState,
      min_impressions: input.min_impressions,
      min_share_pct: input.min_share_pct,
      total_matches: matches.length,
      rows: matches.slice(0, input.limit),
      truncated,
    };
  },
  format(r) {
    const host = displayHost(r.site_url);
    if (r.total_matches === 0) {
      return `No cannibalization found for ${r.site_url}: no query with ≥${r.min_impressions} impressions has 2+ pages each above ${r.min_share_pct}% share (${r.start_date} → ${r.end_date}).`;
    }
    const blocks = r.rows.map((q) =>
      sections(
        `**"${q.query}"** — ${fmtInt(q.impressions)} impr., ${fmtInt(q.clicks)} clicks, ${q.competing_pages} competing pages`,
        mdTable(
          ['Page', 'Share', 'Impr.', 'Clicks', 'Pos.'],
          q.pages.map((p) => [
            compactUrl(p.page, host),
            fmtPct(p.share_pct),
            fmtInt(p.impressions),
            fmtInt(p.clicks),
            fmtPos(p.position),
          ]),
        ),
      ),
    );
    return sections(
      `**${fmtInt(r.total_matches)} cannibalized queries** for ${r.site_url} (sorted by impressions not going to the top page)`,
      windowNote({
        startDate: r.start_date,
        endDate: r.end_date,
        dataState: r.data_state === 'all' ? 'all' : 'final',
        label: '',
      }),
      ...blocks,
      omittedNote(r.rows.length, r.total_matches, 'Raise `limit` to see more.'),
      truncatedNote(r.truncated),
    );
  },
});
