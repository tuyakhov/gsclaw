import { describe, expect, it } from 'vitest';
import {
  addMonths,
  comparisonRange,
  consecutiveWindows,
  earliestAvailableDate,
  isValidDate,
  previousPeriod,
  rangeLength,
  resolvePreset,
  todayPT,
} from '../src/core/dates.js';
import {
  capText,
  compactUrl,
  fmtChange,
  fmtPct,
  mdTable,
  omittedNote,
  sumMetrics,
  toMetrics,
} from '../src/core/format.js';

describe('dates', () => {
  it('uses Pacific Time for "today"', () => {
    expect(todayPT(new Date('2026-10-08T05:00:00Z'))).toBe('2026-10-07');
    expect(todayPT(new Date('2026-10-08T08:00:00Z'))).toBe('2026-10-08');
  });

  it('resolves presets ending on the given date', () => {
    expect(resolvePreset('last_7_days', '2026-10-05')).toEqual({
      startDate: '2026-09-29',
      endDate: '2026-10-05',
    });
    expect(resolvePreset('last_28_days', '2026-10-05')).toEqual({
      startDate: '2026-09-08',
      endDate: '2026-10-05',
    });
    expect(resolvePreset('last_3_months', '2026-10-05')).toEqual({
      startDate: '2026-07-06',
      endDate: '2026-10-05',
    });
    expect(resolvePreset('previous_period', '2026-10-05')).toEqual({
      startDate: '2026-08-11',
      endDate: '2026-09-07',
    });
  });

  it('builds comparison ranges of equal length', () => {
    const range = { startDate: '2026-09-08', endDate: '2026-10-05' };
    const prev = previousPeriod(range);
    expect(prev).toEqual({ startDate: '2026-08-11', endDate: '2026-09-07' });
    expect(rangeLength(prev)).toBe(rangeLength(range));
    expect(comparisonRange(range, 'year_over_year')).toEqual({
      startDate: '2025-09-08',
      endDate: '2025-10-05',
    });
  });

  it('clamps month arithmetic', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
  });

  it('knows the 16-month retention window', () => {
    expect(earliestAvailableDate('2026-10-08')).toBe('2025-06-09');
  });

  it('splits consecutive windows oldest first', () => {
    expect(consecutiveWindows('2026-10-05', 2, 7)).toEqual([
      { startDate: '2026-09-22', endDate: '2026-09-28' },
      { startDate: '2026-09-29', endDate: '2026-10-05' },
    ]);
  });

  it('validates dates strictly', () => {
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2026-2-28')).toBe(false);
  });
});

describe('format', () => {
  it('rounds metrics and expresses CTR as a percentage', () => {
    expect(toMetrics({ clicks: 12, impressions: 345, ctr: 0.0347826, position: 7.4567 })).toEqual({
      clicks: 12,
      impressions: 345,
      ctr_pct: 3.48,
      position: 7.5,
    });
    expect(toMetrics({ clicks: 0, impressions: 0 }).position).toBeNull();
  });

  it('sums with impression-weighted position', () => {
    const total = sumMetrics([
      { clicks: 10, impressions: 100, position: 2 },
      { clicks: 0, impressions: 300, position: 10 },
    ]);
    expect(total).toEqual({ clicks: 10, impressions: 400, ctr_pct: 2.5, position: 8 });
  });

  it('formats percentages and changes', () => {
    expect(fmtPct(0.42)).toBe('0.42%');
    expect(fmtPct(12.345)).toBe('12.3%');
    expect(fmtChange(150, 100)).toBe('+50 (+50.0%)');
    expect(fmtChange(80, 100)).toBe('-20 (-20.0%)');
    expect(fmtChange(5, 0)).toBe('+5 (new)');
  });

  it('builds markdown tables and escapes pipes', () => {
    expect(mdTable(['a', 'b'], [['x|y', 1]])).toBe('| a | b |\n|---|---|\n| x\\|y | 1 |');
    expect(mdTable(['a'], [])).toBe('_No rows._');
  });

  it('notes omitted rows', () => {
    expect(omittedNote(25, 25, '')).toBeNull();
    expect(omittedNote(25, 1025, 'Raise limit.')).toBe(
      '_1,000 more row(s) not shown (25 of 1,025). Raise limit._',
    );
  });

  it('shortens same-host URLs', () => {
    expect(compactUrl('https://example.com/pricing?x=1', 'example.com')).toBe('/pricing?x=1');
    expect(compactUrl('https://blog.example.com/a', 'example.com')).toBe('blog.example.com/a');
  });

  it('caps very long text', () => {
    expect(capText('x'.repeat(100), 10)).toMatch(/^x{10}\n\n_\[Output truncated/);
  });
});
