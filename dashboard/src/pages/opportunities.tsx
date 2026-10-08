import { useState } from 'preact/hooks';
import type {
  CannibalizationRow,
  CtrOpportunityRow,
  StrikingDistanceRow,
} from '../../../src/core/analysis/opportunities.js';
import type { DecayRow } from '../../../src/core/analysis/decay.js';
import { compactUrl, fmtInt, fmtPct, fmtPos } from '../../../src/core/format.js';
import { runTool } from '../api.js';
import { DataTable, type Column } from '../components/table.js';
import { Card, CopyButton, ErrorBox, Loading, Tabs } from '../components/ui.js';
import { useAsync } from '../state.js';
import type { PageProps } from './overview.js';

const TABS = [
  { value: 'striking', label: 'Striking distance' },
  { value: 'ctr', label: 'CTR gaps' },
  { value: 'cannibalization', label: 'Cannibalization' },
  { value: 'decay', label: 'Content decay' },
] as const;
type Tab = (typeof TABS)[number]['value'];

const hostOf = (site: string) => (site.startsWith('sc-domain:') ? undefined : new URL(site).host);

/** "Ask AI" copies a ready-made prompt for Claude (or any client connected to GSClaw). */
function AskAi({ prompt }: { prompt: string }) {
  return (
    <CopyButton small text={prompt} label="Ask AI" title="Copy a prompt to paste into Claude" />
  );
}

export function Opportunities({ site, range }: PageProps) {
  const [tab, setTab] = useState<Tab>('striking');
  return (
    <>
      <h1>Opportunities</h1>
      <p class="sub">
        What GSClaw's analysis tools find for this property. "Ask AI" copies a prompt you can paste
        into Claude to dig in.
      </p>
      <Tabs label="Opportunity type" value={tab} tabs={TABS} onChange={setTab} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'striking' && <Striking site={site} range={range} />}
        {tab === 'ctr' && <CtrGaps site={site} range={range} />}
        {tab === 'cannibalization' && <Cannibalization site={site} range={range} />}
        {tab === 'decay' && <Decay site={site} />}
      </div>
    </>
  );
}

function Striking({ site, range }: { site: string; range: string }) {
  const state = useAsync(
    () => runTool('striking_distance_keywords', { site_url: site, date_range: range, limit: 100 }),
    [site, range],
  );
  const host = hostOf(site);
  const columns: Column<StrikingDistanceRow>[] = [
    { label: 'Query', render: (r) => r.query, csv: (r) => r.query },
    {
      label: 'Ranking page',
      render: (r) => <span title={r.page}>{compactUrl(r.page, host)}</span>,
      csv: (r) => r.page,
    },
    { label: 'Pos.', numeric: true, render: (r) => fmtPos(r.position), csv: (r) => r.position },
    {
      label: 'Impr.',
      numeric: true,
      render: (r) => fmtInt(r.impressions),
      csv: (r) => r.impressions,
    },
    { label: 'Clicks', numeric: true, render: (r) => fmtInt(r.clicks), csv: (r) => r.clicks },
    {
      label: 'Potential',
      numeric: true,
      render: (r) => `+${fmtInt(r.potential_extra_clicks)}`,
      csv: (r) => r.potential_extra_clicks,
    },
    {
      label: '',
      render: (r) => (
        <AskAi
          prompt={`Using GSClaw, look at the query "${r.query}" on ${site}: ${r.page} ranks at average position ${fmtPos(r.position)} with ${fmtInt(r.impressions)} impressions. Check its page_report and suggest concrete changes to move it into the top 3.`}
        />
      ),
    },
  ];
  return (
    <Card>
      {state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <Loading />
      ) : (
        <DataTable
          caption="Striking-distance keywords"
          columns={columns}
          rows={state.data.rows}
          csvName="striking-distance"
          footer={`${fmtInt(state.data.total_matches)} queries at position ${state.data.position_range.join('–')} · potential = extra clicks at #${state.data.target_position} (${fmtPct(state.data.expected_ctr_at_target_pct)} CTR)`}
          empty="No striking-distance queries in this period."
        />
      )}
    </Card>
  );
}

function CtrGaps({ site, range }: { site: string; range: string }) {
  const state = useAsync(
    () => runTool('ctr_opportunities', { site_url: site, date_range: range, limit: 100 }),
    [site, range],
  );
  const columns: Column<CtrOpportunityRow>[] = [
    { label: 'Query', render: (r) => r.key, csv: (r) => r.key },
    { label: 'Pos.', numeric: true, render: (r) => fmtPos(r.position), csv: (r) => r.position },
    {
      label: 'Impr.',
      numeric: true,
      render: (r) => fmtInt(r.impressions),
      csv: (r) => r.impressions,
    },
    { label: 'CTR', numeric: true, render: (r) => fmtPct(r.ctr_pct), csv: (r) => r.ctr_pct },
    {
      label: 'Expected',
      numeric: true,
      render: (r) => fmtPct(r.expected_ctr_pct),
      csv: (r) => r.expected_ctr_pct,
    },
    {
      label: 'Missed clicks',
      numeric: true,
      render: (r) => fmtInt(r.missed_clicks),
      csv: (r) => r.missed_clicks,
    },
    {
      label: '',
      render: (r) => (
        <AskAi
          prompt={`Using GSClaw, the query "${r.key}" on ${site} ranks at position ${fmtPos(r.position)} but its CTR is ${fmtPct(r.ctr_pct)} (about ${fmtPct(r.expected_ctr_pct)} is typical there). Find the ranking page and suggest a better title tag, meta description and rich-result markup.`}
        />
      ),
    },
  ];
  return (
    <Card>
      {state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <Loading />
      ) : (
        <>
          <DataTable
            caption="CTR opportunities"
            columns={columns}
            rows={state.data.rows}
            csvName="ctr-opportunities"
            footer={`${fmtInt(state.data.total_matches)} queries below ${state.data.threshold_pct}% of the expected CTR`}
            empty="No queries with a CTR well below expectation."
          />
          <details class="curve">
            <summary>Benchmark CTR curve used</summary>
            <p class="small">
              {state.data.curve
                .map(
                  (p) => `#${p.position} ${fmtPct(p.ctr_pct)}${p.source === 'industry' ? '*' : ''}`,
                )
                .join(' · ')}
            </p>
            <p class="small muted">
              Your site's median CTR per position where there's enough data; * = industry fallback.
            </p>
          </details>
        </>
      )}
    </Card>
  );
}

function Cannibalization({ site, range }: { site: string; range: string }) {
  const state = useAsync(
    () => runTool('keyword_cannibalization', { site_url: site, date_range: range, limit: 100 }),
    [site, range],
  );
  const host = hostOf(site);
  const columns: Column<CannibalizationRow>[] = [
    { label: 'Query', render: (r) => r.query, csv: (r) => r.query },
    {
      label: 'Competing pages (impression share)',
      render: (r) => (
        <ul class="plain">
          {r.pages.map((p) => (
            <li>
              <span title={p.page}>{compactUrl(p.page, host)}</span>{' '}
              <span class="muted">{fmtPct(p.share_pct)}</span>
            </li>
          ))}
        </ul>
      ),
      csv: (r) => r.pages.map((p) => `${p.page} (${p.share_pct}%)`).join(' | '),
    },
    {
      label: 'Impr.',
      numeric: true,
      render: (r) => fmtInt(r.impressions),
      csv: (r) => r.impressions,
    },
    { label: 'Clicks', numeric: true, render: (r) => fmtInt(r.clicks), csv: (r) => r.clicks },
    {
      label: '',
      render: (r) => (
        <AskAi
          prompt={`Using GSClaw, analyze keyword cannibalization for "${r.query}" on ${site}. These pages compete: ${r.pages.map((p) => `${p.page} (${p.share_pct}% of impressions)`).join(', ')}. Recommend which page should own the query and what to change on the others.`}
        />
      ),
    },
  ];
  return (
    <Card>
      {state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <Loading />
      ) : (
        <DataTable
          caption="Keyword cannibalization"
          columns={columns}
          rows={state.data.rows}
          csvName="cannibalization"
          footer={`${fmtInt(state.data.total_matches)} queries with 2+ pages above ${state.data.min_share_pct}% share`}
          empty="No cannibalization found in this period."
        />
      )}
    </Card>
  );
}

const CAUSE: Record<DecayRow['likely_cause'], string> = {
  ranking_loss: 'Rankings dropped',
  lower_demand: 'Fewer impressions',
  lower_ctr: 'CTR fell',
  mixed: 'Mixed',
};

function Decay({ site }: { site: string }) {
  const state = useAsync(() => runTool('content_decay', { site_url: site, limit: 100 }), [site]);
  const host = hostOf(site);
  const columns: Column<DecayRow>[] = [
    {
      label: 'Page',
      render: (r) => <span title={r.page}>{compactUrl(r.page, host)}</span>,
      csv: (r) => r.page,
    },
    {
      label: 'Clicks per 28 days',
      render: (r) => r.clicks.map(fmtInt).join(' → '),
      csv: (r) => r.clicks.join(' > '),
    },
    {
      label: 'Lost',
      numeric: true,
      render: (r) => `−${fmtInt(r.lost_clicks)} (−${r.decline_pct}%)`,
      csv: (r) => r.lost_clicks,
    },
    {
      label: 'Position',
      render: (r) => `${fmtPos(r.position[0] ?? null)} → ${fmtPos(r.position.at(-1) ?? null)}`,
      csv: (r) => r.position.at(-1) ?? '',
    },
    { label: 'Likely cause', render: (r) => CAUSE[r.likely_cause], csv: (r) => r.likely_cause },
    {
      label: '',
      render: (r) => (
        <AskAi
          prompt={`Using GSClaw, analyze why ${r.page} on ${site} lost ${fmtInt(r.lost_clicks)} clicks (−${r.decline_pct}%) over the last ${r.clicks.length} × 28 days. Compare its queries period over period, inspect the URL, and suggest fixes.`}
        />
      ),
    },
  ];
  return (
    <Card>
      {state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <Loading />
      ) : (
        <DataTable
          caption="Content decay"
          columns={columns}
          rows={state.data.rows}
          csvName="content-decay"
          footer={`${fmtInt(state.data.total_matches)} pages with sustained decline · ${state.data.windows[0]?.startDate} → ${state.data.windows.at(-1)?.endDate}`}
          empty="No pages with sustained click decline."
        />
      )}
    </Card>
  );
}
