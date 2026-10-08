// Compact, LLM-friendly formatting. Numbers are rounded, CTR is a percentage, and long result
// sets are cut to the top N rows with an explicit note about what was left out.

export interface Metrics {
  clicks: number;
  impressions: number;
  /** Click-through rate in percent (0–100), rounded to 2 decimals. */
  ctr_pct: number;
  /** Average position (1 = top), rounded to 1 decimal. Null when there were no impressions. */
  position: number | null;
}

export interface RawMetrics {
  clicks: number;
  impressions: number;
  ctr?: number;
  position?: number;
}

export function round(value: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function toMetrics(raw: RawMetrics): Metrics {
  const ctr = raw.ctr ?? (raw.impressions > 0 ? raw.clicks / raw.impressions : 0);
  return {
    clicks: round(raw.clicks),
    impressions: round(raw.impressions),
    ctr_pct: round(ctr * 100, 2),
    position: raw.impressions > 0 && raw.position !== undefined ? round(raw.position, 1) : null,
  };
}

/** Sums rows into totals, with impression-weighted average position (how GSC aggregates). */
export function sumMetrics(rows: RawMetrics[]): Metrics {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weightedPosition += (r.position ?? 0) * r.impressions;
  }
  return toMetrics({
    clicks,
    impressions,
    position: impressions > 0 ? weightedPosition / impressions : undefined,
  });
}

export function fmtInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function fmtPct(pct: number): string {
  const abs = Math.abs(pct);
  return `${abs > 0 && abs < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export function fmtPos(position: number | null): string {
  return position === null ? '–' : position.toFixed(1);
}

export function fmtSigned(value: number, format: (v: number) => string = fmtInt): string {
  if (value === 0) return format(0);
  return value > 0 ? `+${format(value)}` : `-${format(Math.abs(value))}`;
}

/** Relative change in percent, or null when the base is zero. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

export function fmtChange(current: number, previous: number): string {
  const diff = current - previous;
  const rel = pctChange(current, previous);
  if (rel === null) return current === 0 ? '0' : `${fmtSigned(diff)} (new)`;
  return `${fmtSigned(diff)} (${fmtSigned(rel, (v) => `${v.toFixed(1)}%`)})`;
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

export function mdTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  if (rows.length === 0) return '_No rows._';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

export function omittedNote(shown: number, total: number, hint: string): string | null {
  if (total <= shown) return null;
  return `_${fmtInt(total - shown)} more row(s) not shown (${fmtInt(shown)} of ${fmtInt(total)}). ${hint}_`;
}

/**
 * Shortens a page URL for display: same-host URLs become their path. The full URL is always kept
 * in structured output.
 */
export function compactUrl(url: string, baseHost?: string): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}${u.hash}`;
    if (baseHost && u.host === baseHost) return path;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/** Joins non-empty sections with blank lines. */
export function sections(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join('\n\n');
}

/** Hard cap so a single tool result never blows past client limits (claude.ai: ~150K chars). */
export const MAX_TEXT_CHARS = 60_000;

export function capText(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n_[Output truncated at ${fmtInt(max)} characters. Narrow the query or lower \`limit\`.]_`;
}
