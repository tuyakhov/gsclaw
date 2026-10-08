import { useEffect, useRef } from 'preact/hooks';
import uPlot from 'uplot';
import { fmtInt } from '../../../src/core/format.js';

export interface TrendPoint {
  date: string;
  clicks: number;
  impressions: number;
}

const HEIGHT = 280;

/** Clicks (left axis) and impressions (right axis) per day. Dates are Search Console (PT) days. */
export function TrendChart({ points, theme }: { points: TrendPoint[]; theme: 'light' | 'dark' }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const data: uPlot.AlignedData = [
      points.map((p) => Date.parse(`${p.date}T00:00:00Z`) / 1000),
      points.map((p) => p.clicks),
      points.map((p) => p.impressions),
    ];
    // uPlot sides: 1 = right, 2 = bottom, 3 = left. Set explicitly; a scale-bound axis without a
    // side can end up horizontal and steal plot height.
    const axis = (scale: string, stroke: string, right = false): uPlot.Axis => ({
      scale,
      side: right ? 1 : 3,
      stroke,
      grid: { show: !right, stroke: color('--grid'), width: 1 },
      ticks: { show: false },
      values: (_u, values) =>
        values.map((v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : fmtInt(v))),
      size: 56,
    });
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: HEIGHT,
        tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
        cursor: { drag: { x: false, y: false } },
        legend: { live: true },
        scales: {
          x: { time: true },
          clicks: { range: (_u, _min, max) => [0, (max || 1) * 1.15] },
          impressions: { range: (_u, _min, max) => [0, (max || 1) * 1.15] },
        },
        series: [
          {},
          {
            label: 'Clicks',
            scale: 'clicks',
            stroke: color('--clicks'),
            width: 2,
            value: (_u, v) => (v === null ? '–' : fmtInt(v)),
          },
          {
            label: 'Impressions',
            scale: 'impressions',
            stroke: color('--impressions'),
            width: 2,
            value: (_u, v) => (v === null ? '–' : fmtInt(v)),
          },
        ],
        axes: [
          {
            side: 2,
            stroke: color('--muted'),
            grid: { stroke: color('--grid'), width: 1 },
            ticks: { show: false },
          },
          axis('clicks', color('--clicks')),
          axis('impressions', color('--impressions'), true),
        ],
      },
      data,
      el,
    );
    const resize = new ResizeObserver(() =>
      plot.setSize({ width: el.clientWidth, height: HEIGHT }),
    );
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [points, theme]);

  const first = points[0]?.date;
  const last = points.at(-1)?.date;
  return (
    <div
      ref={ref}
      class="chart"
      role="img"
      aria-label={first ? `Daily clicks and impressions from ${first} to ${last}` : 'No data'}
    />
  );
}
