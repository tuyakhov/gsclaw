import { round } from '../format.js';

export interface CurvePoint {
  position: number;
  /** Expected CTR in percent. */
  ctr_pct: number;
  source: 'site' | 'industry';
  samples: number;
}

/**
 * Approximate organic CTR by position (percent), compiled from public click-through-rate studies
 * of Google results. Real CTRs vary a lot by query intent, brand vs non-brand, device and SERP
 * features such as AI Overviews, which is why GSClaw prefers the site's own curve when it has
 * enough data.
 */
export const INDUSTRY_CTR_CURVE: readonly number[] = [
  27.0,
  15.0,
  11.0,
  8.0,
  6.0,
  4.6,
  3.6,
  2.9,
  2.4,
  2.0, // positions 1–10
  1.6,
  1.4,
  1.2,
  1.1,
  1.0,
  0.9,
  0.8,
  0.7,
  0.65,
  0.6, // positions 11–20
];

export const MAX_CURVE_POSITION = INDUSTRY_CTR_CURVE.length;

export interface CurveInputRow {
  clicks: number;
  impressions: number;
  position: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Builds a CTR-by-position curve. With `benchmark: 'site'`, each position bucket uses the median
 * CTR of the site's own rows (rows with at least `minImpressions`) when it has `minSamples` of
 * them, and the industry curve otherwise. The curve is forced to be non-increasing.
 */
export function buildCtrCurve(
  rows: CurveInputRow[],
  opts: { benchmark: 'site' | 'industry'; minImpressions?: number; minSamples?: number },
): CurvePoint[] {
  const minImpressions = opts.minImpressions ?? 20;
  const minSamples = opts.minSamples ?? 8;
  const buckets = new Map<number, number[]>();
  if (opts.benchmark === 'site') {
    for (const r of rows) {
      if (r.impressions < minImpressions) continue;
      const bucket = Math.round(r.position);
      if (bucket < 1 || bucket > MAX_CURVE_POSITION) continue;
      const list = buckets.get(bucket) ?? [];
      list.push((r.clicks / r.impressions) * 100);
      buckets.set(bucket, list);
    }
  }

  const curve: CurvePoint[] = [];
  for (let position = 1; position <= MAX_CURVE_POSITION; position++) {
    const samples = buckets.get(position) ?? [];
    const useSite = samples.length >= minSamples;
    let ctr = useSite ? median(samples) : INDUSTRY_CTR_CURVE[position - 1]!;
    const prev = curve.at(-1);
    if (prev && ctr > prev.ctr_pct) ctr = prev.ctr_pct;
    curve.push({
      position,
      ctr_pct: round(ctr, 2),
      source: useSite ? 'site' : 'industry',
      samples: samples.length,
    });
  }
  return curve;
}

/** Expected CTR (percent) at a fractional position, interpolating linearly between buckets. */
export function expectedCtr(curve: CurvePoint[], position: number): number {
  if (curve.length === 0) return 0;
  if (position <= 1) return curve[0]!.ctr_pct;
  if (position >= curve.length) return curve.at(-1)!.ctr_pct;
  const lower = Math.floor(position);
  const frac = position - lower;
  const a = curve[lower - 1]!.ctr_pct;
  const b = curve[lower]!.ctr_pct;
  return a + (b - a) * frac;
}
