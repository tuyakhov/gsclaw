import { round, toMetrics, type RawMetrics } from '../format.js';

export interface DecayRow {
  page: string;
  /** Clicks per window, oldest first. */
  clicks: number[];
  impressions: number[];
  position: (number | null)[];
  baseline_clicks: number;
  latest_clicks: number;
  lost_clicks: number;
  decline_pct: number;
  /** Number of window-to-window declines (sustained decay has many). */
  declines: number;
  likely_cause: 'ranking_loss' | 'lower_demand' | 'lower_ctr' | 'mixed';
}

/**
 * Pages whose clicks fell steadily across consecutive windows: at least `minBaselineClicks` in the
 * first window, at least `minDeclinePct` lower in the last one, and falling in all but at most one
 * window-to-window step.
 */
export function findContentDecay(
  series: Map<string, (RawMetrics | undefined)[]>,
  windows: number,
  opts: { minBaselineClicks: number; minDeclinePct: number },
): DecayRow[] {
  const out: DecayRow[] = [];
  const requiredDeclines = Math.max(1, windows - 2);
  for (const [page, values] of series) {
    const metrics = Array.from({ length: windows }, (_, i) =>
      toMetrics(values[i] ?? { clicks: 0, impressions: 0 }),
    );
    const clicks = metrics.map((m) => m.clicks);
    const baseline = clicks[0]!;
    const latest = clicks.at(-1)!;
    if (baseline < opts.minBaselineClicks) continue;
    const declinePct = ((baseline - latest) / baseline) * 100;
    if (declinePct < opts.minDeclinePct) continue;
    let declines = 0;
    for (let i = 1; i < clicks.length; i++) if (clicks[i]! < clicks[i - 1]!) declines++;
    if (declines < requiredDeclines) continue;

    const first = metrics[0]!;
    const last = metrics.at(-1)!;
    const positionDrop =
      first.position !== null && last.position !== null ? last.position - first.position : 0;
    const impressionDrop = first.impressions
      ? (first.impressions - last.impressions) / first.impressions
      : 0;
    const ctrDrop = first.ctr_pct ? (first.ctr_pct - last.ctr_pct) / first.ctr_pct : 0;
    let cause: DecayRow['likely_cause'] = 'mixed';
    if (positionDrop >= 1.5) cause = 'ranking_loss';
    else if (impressionDrop >= 0.2 && Math.abs(positionDrop) < 1) cause = 'lower_demand';
    else if (ctrDrop >= 0.2 && Math.abs(positionDrop) < 1) cause = 'lower_ctr';

    out.push({
      page,
      clicks,
      impressions: metrics.map((m) => m.impressions),
      position: metrics.map((m) => m.position),
      baseline_clicks: baseline,
      latest_clicks: latest,
      lost_clicks: baseline - latest,
      decline_pct: round(declinePct, 1),
      declines,
      likely_cause: cause,
    });
  }
  return out.sort((a, b) => b.lost_clicks - a.lost_clicks);
}
