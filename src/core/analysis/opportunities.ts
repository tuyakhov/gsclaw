import { round, toMetrics, type Metrics } from '../format.js';
import { expectedCtr, type CurvePoint } from './ctr-curve.js';

/** A query × page row as returned by Search Console. */
export interface QueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface PageShare extends Metrics {
  page: string;
  share_pct: number;
}

function groupByQuery(
  rows: QueryPageRow[],
  mergeFragments: boolean,
): Map<string, Map<string, QueryPageRow>> {
  const byQuery = new Map<string, Map<string, QueryPageRow>>();
  for (const row of rows) {
    const page = mergeFragments ? row.page.split('#')[0]! : row.page;
    const pages = byQuery.get(row.query) ?? new Map<string, QueryPageRow>();
    const existing = pages.get(page);
    if (existing) {
      const impressions = existing.impressions + row.impressions;
      pages.set(page, {
        ...existing,
        clicks: existing.clicks + row.clicks,
        impressions,
        ctr: impressions ? (existing.clicks + row.clicks) / impressions : 0,
        position: impressions
          ? (existing.position * existing.impressions + row.position * row.impressions) /
            impressions
          : existing.position,
      });
    } else {
      pages.set(page, { ...row, page });
    }
    byQuery.set(row.query, pages);
  }
  return byQuery;
}

/**
 * Google reports each sitelink as its own query × page row. Pages shown together in one result
 * share exactly the same impressions and position, so 2+ pages of a query that match on both are
 * treated as one result. If another page of the query has more impressions, it is the main link
 * and the whole group is its sitelinks; otherwise the group is the main result and keeps its best
 * page. Sitelinks don't compete with anything, so the analyses below leave them out.
 */
export function withoutSitelinks(pages: QueryPageRow[]): {
  pages: QueryPageRow[];
  sitelinks: number;
} {
  const groups = new Map<string, QueryPageRow[]>();
  for (const page of pages) {
    if (page.impressions < 10) continue;
    const key = `${page.impressions}|${page.position.toFixed(1)}`;
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  const dropped = new Set<QueryPageRow>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const isMain = !pages.some((p) => p.impressions > group[0]!.impressions);
    const keep = isMain
      ? [...group].sort((a, b) => b.clicks - a.clicks || a.page.length - b.page.length)[0]
      : undefined;
    for (const page of group) if (page !== keep) dropped.add(page);
  }
  return { pages: pages.filter((p) => !dropped.has(p)), sitelinks: dropped.size };
}

// ---------------------------------------------------------------------------------------------
// Striking distance
// ---------------------------------------------------------------------------------------------

export interface StrikingDistanceRow extends Metrics {
  query: string;
  /** The page that ranks for the query (most impressions). */
  page: string;
  /** Other pages of the site that also appear for this query (not counting sitelinks). */
  other_pages: number;
  /** Estimated extra clicks/period if this page reached `target_position`. */
  potential_extra_clicks: number;
}

export function findStrikingDistance(
  rows: QueryPageRow[],
  opts: {
    minPosition: number;
    maxPosition: number;
    minImpressions: number;
    targetPosition: number;
    curve: CurvePoint[];
  },
): StrikingDistanceRow[] {
  const targetCtr = expectedCtr(opts.curve, opts.targetPosition) / 100;
  const out: StrikingDistanceRow[] = [];
  for (const [query, pages] of groupByQuery(rows, true)) {
    const sorted = withoutSitelinks([...pages.values()]).pages.sort(
      (a, b) => b.impressions - a.impressions,
    );
    const primary = sorted[0]!;
    if (primary.position < opts.minPosition || primary.position > opts.maxPosition) continue;
    if (primary.impressions < opts.minImpressions) continue;
    const metrics = toMetrics(primary);
    out.push({
      query,
      page: primary.page,
      ...metrics,
      other_pages: sorted.length - 1,
      potential_extra_clicks: Math.max(
        0,
        Math.round(primary.impressions * targetCtr - primary.clicks),
      ),
    });
  }
  return out.sort(
    (a, b) => b.potential_extra_clicks - a.potential_extra_clicks || b.impressions - a.impressions,
  );
}

// ---------------------------------------------------------------------------------------------
// CTR opportunities
// ---------------------------------------------------------------------------------------------

export interface CtrOpportunityRow extends Metrics {
  key: string;
  expected_ctr_pct: number;
  /** Actual minus expected CTR, in percentage points (negative = underperforming). */
  ctr_gap_pp: number;
  /** Clicks lost versus the expected CTR at this position. */
  missed_clicks: number;
}

export function findCtrOpportunities(
  rows: { key: string; clicks: number; impressions: number; ctr: number; position: number }[],
  opts: { maxPosition: number; minImpressions: number; threshold: number; curve: CurvePoint[] },
): CtrOpportunityRow[] {
  const out: CtrOpportunityRow[] = [];
  for (const row of rows) {
    if (row.impressions < opts.minImpressions || row.position > opts.maxPosition) continue;
    const expected = expectedCtr(opts.curve, row.position);
    const actual = (row.clicks / row.impressions) * 100;
    if (actual >= expected * opts.threshold) continue;
    out.push({
      key: row.key,
      ...toMetrics(row),
      expected_ctr_pct: round(expected, 2),
      ctr_gap_pp: round(actual - expected, 2),
      missed_clicks: Math.round(row.impressions * (expected / 100) - row.clicks),
    });
  }
  return out.sort((a, b) => b.missed_clicks - a.missed_clicks);
}

// ---------------------------------------------------------------------------------------------
// Keyword cannibalization
// ---------------------------------------------------------------------------------------------

export interface CannibalizationRow {
  query: string;
  clicks: number;
  impressions: number;
  /** Impressions that went to pages other than the top one. */
  contested_impressions: number;
  competing_pages: number;
  /** Pages Google showed as sitelinks for this query, left out of the analysis. */
  sitelinks_ignored: number;
  pages: PageShare[];
}

export function findCannibalization(
  rows: QueryPageRow[],
  opts: { minImpressions: number; minSharePct: number; maxPagesShown?: number },
): CannibalizationRow[] {
  const out: CannibalizationRow[] = [];
  for (const [query, pages] of groupByQuery(rows, true)) {
    const { pages: list, sitelinks } = withoutSitelinks([...pages.values()]);
    if (list.length < 2) continue;
    const impressions = list.reduce((s, r) => s + r.impressions, 0);
    if (impressions < opts.minImpressions) continue;
    const shares: PageShare[] = list
      .map((r) => ({
        page: r.page,
        ...toMetrics(r),
        share_pct: round((r.impressions / impressions) * 100, 1),
      }))
      .sort((a, b) => b.impressions - a.impressions);
    const competing = shares.filter((s) => s.share_pct >= opts.minSharePct);
    if (competing.length < 2) continue;
    out.push({
      query,
      clicks: list.reduce((s, r) => s + r.clicks, 0),
      impressions,
      contested_impressions: impressions - shares[0]!.impressions,
      competing_pages: competing.length,
      sitelinks_ignored: sitelinks,
      pages: shares.slice(0, opts.maxPagesShown ?? 5),
    });
  }
  return out.sort((a, b) => b.contested_impressions - a.contested_impressions);
}
