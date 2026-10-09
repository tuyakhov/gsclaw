import { z } from 'zod';
import {
  addDays,
  DATE_PRESETS,
  DEFAULT_LAG_DAYS,
  earliestAvailableDate,
  isValidDate,
  resolvePreset,
  todayPT,
  type DatePreset,
  type DateRange,
} from '../dates.js';
import { UserFacingError } from '../errors.js';
import type { RawMetrics } from '../format.js';
import {
  FILTER_DIMENSIONS,
  FILTER_OPERATORS,
  SEARCH_TYPES,
  type Dimension,
  type DimensionFilter,
  type SearchAnalyticsRow,
  type SearchType,
} from '../gsc/types.js';
import { resolveProperty, type Property } from '../gsc/sites.js';
import type { ToolContext } from './types.js';

export const siteUrlField = z
  .string()
  .min(1)
  .describe(
    "Search Console property: 'sc-domain:example.com', 'https://www.example.com/', or just 'example.com' (matched against your properties; see list_sites). A page URL selects the whole property that contains it; for one page use page_report or a page filter.",
  );

const dateField = z.string().refine(isValidDate, 'Use YYYY-MM-DD.').optional();

export const dateRangeFields = {
  date_range: z
    .enum(DATE_PRESETS)
    .default('last_28_days')
    .describe(
      'Relative period ending on the latest day with final data (Search Console lags ~2–3 days). previous_period = the 28 days before last_28_days.',
    ),
  start_date: dateField.describe(
    'Explicit start date YYYY-MM-DD (Pacific Time). Use together with end_date; overrides date_range.',
  ),
  end_date: dateField.describe('Explicit end date YYYY-MM-DD (Pacific Time), inclusive.'),
  fresh: z
    .boolean()
    .default(false)
    .describe(
      'Include fresh, still-changing data from the most recent ~2 days (dataState "all"). Default: final data only.',
    ),
};

export const searchTypeField = z
  .enum(SEARCH_TYPES)
  .default('web')
  .describe('Search type. Discover and Google News have no query or position data.');

export const filterSchema = z.object({
  dimension: z.enum(FILTER_DIMENSIONS),
  operator: z
    .enum(FILTER_OPERATORS)
    .default('equals')
    .describe(
      'equals/notEquals are case-sensitive; contains/notContains are not; regex uses RE2 syntax.',
    ),
  expression: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      'Value to match. Countries are ISO 3166-1 alpha-3 (e.g. USA); devices are DESKTOP, MOBILE, TABLET.',
    ),
});

export const filtersField = z
  .array(filterSchema)
  .max(20)
  .optional()
  .describe('Filters, all ANDed together.');

export function limitField(defaultValue: number, max = 500) {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultValue)
    .describe(
      `How many rows to show (top N, default ${defaultValue}). Results always say how many more exist.`,
    );
}

export interface DateInput {
  date_range: DatePreset;
  start_date?: string;
  end_date?: string;
  fresh: boolean;
}

export interface ResolvedWindow extends DateRange {
  dataState: 'final' | 'all';
  label: string;
}

/**
 * Latest date that already has final data, found with a cheap date-grouped query (cached by the
 * client). Falls back to today − 3 days for properties with no recent data.
 */
export async function latestFinalDate(
  ctx: ToolContext,
  siteUrl: string,
  searchType: SearchType,
): Promise<string> {
  const today = todayPT(ctx.now());
  const res = await ctx.gsc.searchAnalytics(siteUrl, {
    startDate: addDays(today, -10),
    endDate: today,
    dimensions: ['date'],
    type: searchType,
    dataState: 'final',
    rowLimit: 15,
  });
  const dates = (res.rows ?? []).map((r) => r.keys?.[0]).filter((d): d is string => Boolean(d));
  return dates.length > 0 ? dates.sort().at(-1)! : addDays(today, -DEFAULT_LAG_DAYS);
}

export async function resolveWindow(
  ctx: ToolContext,
  property: Property,
  input: DateInput,
  searchType: SearchType = 'web',
): Promise<ResolvedWindow> {
  const today = todayPT(ctx.now());
  const dataState = input.fresh ? 'all' : 'final';

  if (input.start_date || input.end_date) {
    if (!input.start_date || !input.end_date) {
      throw new UserFacingError(
        'Provide both start_date and end_date, or neither (to use date_range).',
      );
    }
    if (input.start_date > input.end_date)
      throw new UserFacingError('start_date must be on or before end_date.');
    if (input.end_date > today)
      throw new UserFacingError(
        `end_date cannot be in the future (today is ${today} Pacific Time).`,
      );
    const earliest = earliestAvailableDate(today);
    if (input.end_date < earliest) {
      throw new UserFacingError(
        `Search Console only keeps ~16 months of data; the earliest available date is about ${earliest}.`,
      );
    }
    return {
      startDate: input.start_date < earliest ? earliest : input.start_date,
      endDate: input.end_date,
      dataState,
      label: `${input.start_date} → ${input.end_date}`,
    };
  }

  const endDate = input.fresh ? today : await latestFinalDate(ctx, property.site_url, searchType);
  const range = resolvePreset(input.date_range, endDate);
  const earliest = earliestAvailableDate(today);
  return {
    ...range,
    startDate: range.startDate < earliest ? earliest : range.startDate,
    dataState,
    label: input.date_range,
  };
}

export function windowNote(window: ResolvedWindow): string {
  const state =
    window.dataState === 'all'
      ? 'includes fresh data; the last ~2 days are incomplete and will still change'
      : 'final data only; Search Console lags ~2–3 days';
  return `_${window.startDate} → ${window.endDate} (Pacific Time, ${state})._`;
}

export function toFilterGroups(filters: DimensionFilter[] | undefined) {
  if (!filters || filters.length === 0) return undefined;
  return [{ groupType: 'and' as const, filters }];
}

export interface FetchOptions {
  type?: SearchType;
  filters?: DimensionFilter[];
  maxRows?: number;
  dataState?: 'final' | 'all';
}

/** All rows for a window and dimension set (auto-paginated, capped by GSCLAW_MAX_ROWS). */
export async function fetchRows(
  ctx: ToolContext,
  siteUrl: string,
  range: DateRange,
  dimensions: Dimension[],
  opts: FetchOptions = {},
): Promise<{ rows: SearchAnalyticsRow[]; truncated: boolean }> {
  return ctx.gsc.searchAnalyticsAll(
    siteUrl,
    {
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions,
      type: opts.type ?? 'web',
      dimensionFilterGroups: toFilterGroups(opts.filters),
      dataState: opts.dataState ?? 'final',
    },
    Math.min(opts.maxRows ?? ctx.config.maxRows, ctx.config.maxRows),
  );
}

/** Property totals for a window (a single dimensionless row). */
export async function fetchTotals(
  ctx: ToolContext,
  siteUrl: string,
  range: DateRange,
  opts: FetchOptions = {},
): Promise<RawMetrics> {
  const res = await ctx.gsc.searchAnalytics(siteUrl, {
    startDate: range.startDate,
    endDate: range.endDate,
    type: opts.type ?? 'web',
    dimensionFilterGroups: toFilterGroups(opts.filters),
    dataState: opts.dataState ?? 'final',
    rowLimit: 1,
  });
  return res.rows?.[0] ?? { clicks: 0, impressions: 0 };
}

/** Keyed rows for one dimension, e.g. query → metrics. */
export async function fetchKeyed(
  ctx: ToolContext,
  siteUrl: string,
  range: DateRange,
  dimension: Dimension,
  opts: FetchOptions = {},
): Promise<{ rows: Map<string, RawMetrics>; truncated: boolean }> {
  const { rows, truncated } = await fetchRows(ctx, siteUrl, range, [dimension], opts);
  return { rows: new Map(rows.map((r) => [r.keys?.[0] ?? '', r])), truncated };
}

/** Adds an excludingRegex query filter when a pattern is given (e.g. to drop branded queries). */
export function withQueryExclusion(
  filters: DimensionFilter[] | undefined,
  pattern: string | undefined,
): DimensionFilter[] | undefined {
  if (!pattern) return filters;
  return [
    ...(filters ?? []),
    { dimension: 'query', operator: 'excludingRegex', expression: pattern },
  ];
}

export const excludeQueriesField = z
  .string()
  .max(4096)
  .optional()
  .describe("RE2 regex of queries to exclude, e.g. your brand: 'acme|acme corp'.");

export async function propertyFor(ctx: ToolContext, siteUrl: string): Promise<Property> {
  return resolveProperty(ctx.gsc, siteUrl);
}

/** Host used to shorten page URLs in text output (URL-prefix properties only). */
export function displayHost(siteUrl: string): string | undefined {
  if (siteUrl.startsWith('sc-domain:')) return undefined;
  try {
    return new URL(siteUrl).host;
  } catch {
    return undefined;
  }
}

/** Strips the #fragment Google sometimes reports for jump links and sitelinks. */
export function stripFragment(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
