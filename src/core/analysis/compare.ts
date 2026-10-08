import { pctChange, round, toMetrics, type Metrics, type RawMetrics } from '../format.js';

export interface MetricChange {
  clicks: number;
  clicks_pct: number | null;
  impressions: number;
  impressions_pct: number | null;
  /** CTR change in percentage points. */
  ctr_pp: number;
  /** Positive = ranks higher than before (average position number went down). */
  rank_improvement: number | null;
}

export interface ComparedRow {
  key: string;
  current: Metrics;
  previous: Metrics;
  change: MetricChange;
  status: 'new' | 'lost' | 'both';
}

const EMPTY: RawMetrics = { clicks: 0, impressions: 0 };

export function metricChange(current: Metrics, previous: Metrics): MetricChange {
  return {
    clicks: current.clicks - previous.clicks,
    clicks_pct: pctChange(current.clicks, previous.clicks),
    impressions: current.impressions - previous.impressions,
    impressions_pct: pctChange(current.impressions, previous.impressions),
    ctr_pp: round(current.ctr_pct - previous.ctr_pct, 2),
    rank_improvement:
      current.position !== null && previous.position !== null
        ? round(previous.position - current.position, 1)
        : null,
  };
}

/** Full outer join of two keyed row sets with per-key deltas. */
export function compareRows(
  current: Map<string, RawMetrics>,
  previous: Map<string, RawMetrics>,
): ComparedRow[] {
  const keys = new Set([...current.keys(), ...previous.keys()]);
  const rows: ComparedRow[] = [];
  for (const key of keys) {
    const cur = toMetrics(current.get(key) ?? EMPTY);
    const prev = toMetrics(previous.get(key) ?? EMPTY);
    rows.push({
      key,
      current: cur,
      previous: prev,
      change: metricChange(cur, prev),
      status: !previous.has(key) ? 'new' : !current.has(key) ? 'lost' : 'both',
    });
  }
  return rows;
}

export function topGainers(rows: ComparedRow[], n: number): ComparedRow[] {
  return rows
    .filter((r) => r.change.clicks > 0)
    .sort(
      (a, b) => b.change.clicks - a.change.clicks || b.change.impressions - a.change.impressions,
    )
    .slice(0, n);
}

export function topLosers(rows: ComparedRow[], n: number): ComparedRow[] {
  return rows
    .filter((r) => r.change.clicks < 0)
    .sort(
      (a, b) => a.change.clicks - b.change.clicks || a.change.impressions - b.change.impressions,
    )
    .slice(0, n);
}

export function topByCurrentClicks(rows: ComparedRow[], n: number): ComparedRow[] {
  return [...rows]
    .filter((r) => r.status !== 'lost')
    .sort(
      (a, b) =>
        b.current.clicks - a.current.clicks || b.current.impressions - a.current.impressions,
    )
    .slice(0, n);
}
