// Realistic-looking synthetic data for the demo and README screenshots: a fictional giveaway-tools
// site with weekly seasonality and gentle growth. Tests use the plainer SERIES in fake-gsc.ts.
import { SERIES, type Series } from '../test/helpers/fake-gsc.js';

const P = 'https://example.com';

// [query, page path, daily impressions, position]
const LONG_TAIL: [string, string, number, number][] = [
  ['comment picker', '/tools/comment-picker', 260, 2.4],
  ['wheel of names', '/tools/wheel', 340, 4.2],
  ['spin the wheel', '/tools/wheel', 180, 6.8],
  ['random number generator', '/tools/number', 220, 7.5],
  ['secret santa generator', '/tools/secret-santa', 150, 3.3],
  ['team generator', '/tools/teams', 130, 5.1],
  ['youtube comment picker', '/youtube', 110, 2.9],
  ['tiktok giveaway picker', '/tiktok', 95, 4.8],
  ['facebook giveaway picker', '/facebook', 70, 6.1],
  ['coin flip', '/tools/coin', 160, 11.2],
  ['dice roller', '/tools/dice', 90, 13.6],
  ['yes or no wheel', '/tools/wheel', 75, 8.9],
  ['random group generator', '/tools/teams', 60, 9.7],
  ['giveaway rules template', '/blog/giveaway-rules', 85, 5.6],
  ['how to run a giveaway', '/blog/run-a-giveaway', 120, 7.1],
  ['instagram giveaway ideas', '/blog/giveaway-ideas', 140, 10.4],
  ['raffle ticket generator', '/tools/raffle', 55, 14.8],
  ['random letter generator', '/tools/letter', 45, 12.5],
];

const EXPECTED_CTR = [
  0.3, 0.16, 0.11, 0.08, 0.06, 0.045, 0.035, 0.03, 0.025, 0.02, 0.015, 0.012, 0.01, 0.009, 0.008,
];

/** The test series' deliberate opportunities, plus realistic long-tail queries instead of filler. */
export const DEMO_SERIES: Series[] = [
  ...SERIES.filter((s) => !s.query.startsWith('filler')),
  ...LONG_TAIL.map(([query, path, impressions, position]) => ({
    query,
    page: `${P}${path}`,
    impressions,
    position,
    ctr: EXPECTED_CTR[Math.min(14, Math.floor(position) - 1)]! * 0.9,
  })),
];

/**
 * Each kind of query has its own weekly rhythm (tools are used on weekdays, the blog is read at
 * weekends, brand searches barely change), so the click mix and CTR move like a real site's. Plus
 * slow growth towards today and a little deterministic noise.
 */
export function demoShape(daysAgo: number, date: string, s: Series): number {
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const kind = s.page.includes('/blog/') ? 'blog' : s.query === 'example' ? 'brand' : 'tools';
  const weekly = weekend ? { blog: 1.12, brand: 0.95, tools: 0.72 }[kind] : 1;
  const growth = kind === 'brand' ? 1.3 - daysAgo / 700 : 1.12 - daysAgo / 1500;
  const noise = 1 + 0.06 * Math.sin(daysAgo * 1.7 + s.position) + 0.03 * Math.sin(daysAgo * 0.37);
  return weekly * growth * noise;
}
