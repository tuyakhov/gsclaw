// Search Console reports dates in Pacific Time, so every relative preset is resolved in PT.
// All dates are plain YYYY-MM-DD strings; arithmetic is done in UTC to avoid DST surprises.

export const DATE_PRESETS = [
  'last_7_days',
  'last_28_days',
  'last_3_months',
  'last_6_months',
  'last_12_months',
  'last_16_months',
  'previous_period',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const COMPARE_MODES = ['previous_period', 'year_over_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Search Console keeps roughly 16 months of performance data. */
export const RETENTION_MONTHS = 16;
/** Final (non-fresh) data typically lags by 2–3 days. */
export const DEFAULT_LAG_DAYS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const ptFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function todayPT(now: Date = new Date()): string {
  return ptFormatter.format(now);
}

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** Calendar month arithmetic that clamps to the end of shorter months (Mar 31 − 1 month = Feb 28). */
export function addMonths(date: string, months: number): string {
  const d = toUtc(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return fromUtc(d);
}

/** Inclusive number of days in a range. */
export function rangeLength(range: DateRange): number {
  return (
    Math.round((toUtc(range.endDate).getTime() - toUtc(range.startDate).getTime()) / 86_400_000) + 1
  );
}

export function resolvePreset(preset: DatePreset, endDate: string): DateRange {
  const lastDays = (n: number): DateRange => ({ startDate: addDays(endDate, -(n - 1)), endDate });
  const lastMonths = (n: number): DateRange => ({
    startDate: addDays(addMonths(endDate, -n), 1),
    endDate,
  });
  switch (preset) {
    case 'last_7_days':
      return lastDays(7);
    case 'last_28_days':
      return lastDays(28);
    case 'last_3_months':
      return lastMonths(3);
    case 'last_6_months':
      return lastMonths(6);
    case 'last_12_months':
      return lastMonths(12);
    case 'last_16_months':
      return lastMonths(RETENTION_MONTHS);
    case 'previous_period':
      return previousPeriod(lastDays(28));
  }
}

/** The range of equal length immediately before `range`. */
export function previousPeriod(range: DateRange): DateRange {
  const length = rangeLength(range);
  const endDate = addDays(range.startDate, -1);
  return { startDate: addDays(endDate, -(length - 1)), endDate };
}

/** The same calendar dates one year earlier. */
export function yearOverYear(range: DateRange): DateRange {
  return { startDate: addMonths(range.startDate, -12), endDate: addMonths(range.endDate, -12) };
}

export function comparisonRange(range: DateRange, mode: CompareMode): DateRange {
  return mode === 'year_over_year' ? yearOverYear(range) : previousPeriod(range);
}

/** Oldest date Search Console still has data for, given today's date (PT). */
export function earliestAvailableDate(today: string): string {
  return addDays(addMonths(today, -RETENTION_MONTHS), 1);
}

/** Splits a range into `count` consecutive, equal-length windows ending at `endDate`. */
export function consecutiveWindows(endDate: string, count: number, days: number): DateRange[] {
  const windows: DateRange[] = [];
  let end = endDate;
  for (let i = 0; i < count; i++) {
    const start = addDays(end, -(days - 1));
    windows.unshift({ startDate: start, endDate: end });
    end = addDays(start, -1);
  }
  return windows;
}
