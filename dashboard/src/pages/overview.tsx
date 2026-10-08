import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { ComparedRow } from '../../../src/core/analysis/compare.js';
import { compactUrl, fmtInt, fmtPct, fmtPos } from '../../../src/core/format.js';
import { runTool } from '../api.js';
import { TrendChart } from '../components/chart.js';
import { DataTable, type Column } from '../components/table.js';
import { Card, Delta, ErrorBox, Loading, Segmented } from '../components/ui.js';
import { useAsync, type AsyncState } from '../state.js';

export interface PageProps {
  site: string;
  range: string;
  theme: 'light' | 'dark';
}

const TREND_RANGES = [
  { value: 'last_28_days', label: '28 days' },
  { value: 'last_3_months', label: '3 months' },
  { value: 'last_16_months', label: '16 months' },
] as const;

function hostOf(site: string): string | undefined {
  return site.startsWith('sc-domain:') ? undefined : new URL(site).host;
}

function topColumns(dimension: 'query' | 'page', site: string): Column<ComparedRow>[] {
  const host = hostOf(site);
  return [
    {
      label: dimension === 'query' ? 'Query' : 'Page',
      render: (r) =>
        dimension === 'page' ? <span title={r.key}>{compactUrl(r.key, host)}</span> : r.key,
      csv: (r) => r.key,
    },
    {
      label: 'Clicks',
      numeric: true,
      render: (r) => fmtInt(r.current.clicks),
      csv: (r) => r.current.clicks,
    },
    {
      label: 'Δ',
      numeric: true,
      render: (r) => <Delta value={r.change.clicks} format={fmtInt} />,
      csv: (r) => r.change.clicks,
    },
    {
      label: 'Impr.',
      numeric: true,
      render: (r) => fmtInt(r.current.impressions),
      csv: (r) => r.current.impressions,
    },
    {
      label: 'CTR',
      numeric: true,
      render: (r) => fmtPct(r.current.ctr_pct),
      csv: (r) => r.current.ctr_pct,
    },
    {
      label: 'Pos.',
      numeric: true,
      render: (r) => fmtPos(r.current.position),
      csv: (r) => r.current.position,
    },
    {
      label: 'Δ pos.',
      numeric: true,
      render: (r) => <Delta value={r.change.rank_improvement} format={(v) => v.toFixed(1)} />,
      csv: (r) => r.change.rank_improvement,
    },
  ];
}

export function Overview({ site, range, theme }: PageProps) {
  const [trendRange, setTrendRange] =
    useState<(typeof TREND_RANGES)[number]['value']>('last_3_months');
  const totals = useAsync(
    () => runTool('compare_periods', { site_url: site, date_range: range, dimension: 'none' }),
    [site, range],
  );
  const trend = useAsync(
    () =>
      runTool('search_analytics', {
        site_url: site,
        date_range: trendRange,
        dimensions: ['date'],
        row_limit: 600,
        limit: 500,
        include_totals: false,
      }),
    [site, trendRange],
  );
  const queries = useAsync(
    () =>
      runTool('compare_periods', {
        site_url: site,
        date_range: range,
        dimension: 'query',
        view: 'top',
        limit: 10,
      }),
    [site, range],
  );
  const pages = useAsync(
    () =>
      runTool('compare_periods', {
        site_url: site,
        date_range: range,
        dimension: 'page',
        view: 'top',
        limit: 10,
      }),
    [site, range],
  );

  const t = totals.data?.totals;
  const points = (trend.data?.rows ?? [])
    .map((r) => ({ date: r.keys.date ?? '', clicks: r.clicks, impressions: r.impressions }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return (
    <>
      <h1>Overview</h1>
      {totals.data && (
        <p class="sub">
          {totals.data.current.startDate} → {totals.data.current.endDate}, compared with{' '}
          {totals.data.previous.startDate} → {totals.data.previous.endDate}. Final data only; Search
          Console lags 2–3 days.
        </p>
      )}
      {totals.error ? (
        <ErrorBox error={totals.error} onRetry={totals.reload} />
      ) : !t ? (
        <Loading />
      ) : (
        <div class="kpis">
          <Kpi
            label="Clicks"
            value={fmtInt(t.current.clicks)}
            delta={<Delta value={t.change.clicks_pct} format={(v) => `${v.toFixed(1)}%`} />}
          />
          <Kpi
            label="Impressions"
            value={fmtInt(t.current.impressions)}
            delta={<Delta value={t.change.impressions_pct} format={(v) => `${v.toFixed(1)}%`} />}
          />
          <Kpi
            label="CTR"
            value={fmtPct(t.current.ctr_pct)}
            delta={<Delta value={t.change.ctr_pp} format={(v) => `${v.toFixed(2)} pp`} />}
          />
          <Kpi
            label="Avg position"
            value={fmtPos(t.current.position)}
            delta={<Delta value={t.change.rank_improvement} format={(v) => v.toFixed(1)} />}
          />
        </div>
      )}

      <Card
        title="Clicks & impressions"
        actions={
          <Segmented
            label="Trend range"
            value={trendRange}
            options={TREND_RANGES}
            onChange={setTrendRange}
          />
        }
      >
        {trend.error ? (
          <ErrorBox error={trend.error} onRetry={trend.reload} />
        ) : trend.loading && points.length === 0 ? (
          <Loading />
        ) : points.length === 0 ? (
          <p class="empty">No data in this period.</p>
        ) : (
          <TrendChart points={points} theme={theme} />
        )}
      </Card>

      <div class="grid-2">
        <TopTable
          title="Top queries"
          state={queries}
          columns={topColumns('query', site)}
          csvName="top-queries"
        />
        <TopTable
          title="Top pages"
          state={pages}
          columns={topColumns('page', site)}
          csvName="top-pages"
        />
      </div>
    </>
  );
}

function Kpi(props: { label: string; value: string; delta: ComponentChildren }) {
  return (
    <div class="kpi">
      <span class="kpi-label">{props.label}</span>
      <span class="kpi-value">{props.value}</span>
      <span class="kpi-delta">{props.delta} vs previous period</span>
    </div>
  );
}

function TopTable(props: {
  title: string;
  state: AsyncState<{ top: ComparedRow[]; compared_count: number }>;
  columns: Column<ComparedRow>[];
  csvName: string;
}) {
  const { state } = props;
  return (
    <Card title={props.title}>
      {state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <Loading />
      ) : (
        <DataTable
          caption={props.title}
          columns={props.columns}
          rows={state.data.top}
          csvName={props.csvName}
          footer={`${fmtInt(state.data.compared_count)} compared · Δ vs previous period`}
          empty="No data in this period."
        />
      )}
    </Card>
  );
}
