import { z } from 'zod';
import { findContentDecay, type DecayRow } from '../analysis/decay.js';
import { consecutiveWindows, earliestAvailableDate, todayPT, type DateRange } from '../dates.js';
import { UserFacingError } from '../errors.js';
import {
  compactUrl,
  fmtInt,
  fmtPos,
  mdTable,
  omittedNote,
  sections,
  type RawMetrics,
} from '../format.js';
import {
  displayHost,
  excludeQueriesField,
  fetchKeyed,
  latestFinalDate,
  limitField,
  propertyFor,
  siteUrlField,
} from './common.js';
import { defineTool, READ_ONLY } from './types.js';

export interface ContentDecayResult {
  site_url: string;
  windows: DateRange[];
  min_baseline_clicks: number;
  min_decline_pct: number;
  total_matches: number;
  rows: DecayRow[];
  truncated: boolean;
}

const CAUSE_LABEL: Record<DecayRow['likely_cause'], string> = {
  ranking_loss: 'rankings dropped',
  lower_demand: 'fewer impressions (demand/seasonality)',
  lower_ctr: 'CTR fell (SERP/snippet change)',
  mixed: 'mixed',
};

export const contentDecay = defineTool({
  name: 'content_decay',
  title: 'Content decay',
  description:
    'Finds pages whose clicks declined steadily over consecutive windows (default 4 × 28 days), not just one bad week. For each page: clicks per window, total decline, position trend and a likely cause (ranking loss, lower demand, lower CTR).',
  input: z.object({
    site_url: siteUrlField,
    windows: z
      .number()
      .int()
      .min(3)
      .max(8)
      .default(4)
      .describe('Number of consecutive windows to compare.'),
    window_days: z
      .number()
      .int()
      .min(7)
      .max(91)
      .default(28)
      .describe('Length of each window in days.'),
    min_baseline_clicks: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe('Minimum clicks in the oldest window.'),
    min_decline_pct: z
      .number()
      .min(1)
      .max(100)
      .default(25)
      .describe('Minimum drop from the oldest to the newest window, in percent.'),
    exclude_queries: excludeQueriesField,
    limit: limitField(20),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<ContentDecayResult> {
    const property = await propertyFor(ctx, input.site_url);
    const end = await latestFinalDate(ctx, property.site_url, 'web');
    const windows = consecutiveWindows(end, input.windows, input.window_days);
    const earliest = earliestAvailableDate(todayPT(ctx.now()));
    if (windows[0]!.startDate < earliest) {
      throw new UserFacingError(
        `${input.windows} × ${input.window_days} days reaches back to ${windows[0]!.startDate}, beyond Search Console's ~16 months of data. Use fewer or shorter windows.`,
      );
    }
    const filters = input.exclude_queries
      ? [
          {
            dimension: 'query' as const,
            operator: 'excludingRegex' as const,
            expression: input.exclude_queries,
          },
        ]
      : undefined;
    const results = await Promise.all(
      windows.map((w) => fetchKeyed(ctx, property.site_url, w, 'page', { filters })),
    );
    const series = new Map<string, (RawMetrics | undefined)[]>();
    results.forEach((result, i) => {
      for (const [page, metrics] of result.rows) {
        const url = page.split('#')[0]!;
        const list =
          series.get(url) ?? new Array<RawMetrics | undefined>(windows.length).fill(undefined);
        const prev = list[i];
        list[i] = prev ? mergeMetrics(prev, metrics) : metrics;
        series.set(url, list);
      }
    });
    const matches = findContentDecay(series, windows.length, {
      minBaselineClicks: input.min_baseline_clicks,
      minDeclinePct: input.min_decline_pct,
    });
    return {
      site_url: property.site_url,
      windows,
      min_baseline_clicks: input.min_baseline_clicks,
      min_decline_pct: input.min_decline_pct,
      total_matches: matches.length,
      rows: matches.slice(0, input.limit),
      truncated: results.some((r) => r.truncated),
    };
  },
  format(r) {
    const host = displayHost(r.site_url);
    const span = `${r.windows[0]!.startDate} → ${r.windows.at(-1)!.endDate}, ${r.windows.length} windows`;
    if (r.total_matches === 0) {
      return `No decaying pages on ${r.site_url} (${span}; ≥${r.min_baseline_clicks} clicks in the first window and ≥${r.min_decline_pct}% sustained decline).`;
    }
    return sections(
      `**${fmtInt(r.total_matches)} decaying pages** on ${r.site_url} (${span})`,
      mdTable(
        ['Page', 'Clicks per window', 'Decline', 'Position', 'Likely cause'],
        r.rows.map((row) => [
          compactUrl(row.page, host),
          row.clicks.map(fmtInt).join(' → '),
          `-${fmtInt(row.lost_clicks)} (-${row.decline_pct}%)`,
          `${fmtPos(row.position[0] ?? null)} → ${fmtPos(row.position.at(-1) ?? null)}`,
          CAUSE_LABEL[row.likely_cause],
        ]),
      ),
      omittedNote(r.rows.length, r.total_matches, 'Raise `limit` to see more.'),
      r.truncated ? '_Row cap reached in at least one window; small pages may be missing._' : null,
    );
  },
});

function mergeMetrics(a: RawMetrics, b: RawMetrics): RawMetrics {
  const impressions = a.impressions + b.impressions;
  return {
    clicks: a.clicks + b.clicks,
    impressions,
    position: impressions
      ? ((a.position ?? 0) * a.impressions + (b.position ?? 0) * b.impressions) / impressions
      : undefined,
  };
}
