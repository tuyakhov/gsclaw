import { useState } from 'preact/hooks';
import type { InspectionSummary } from '../../../src/core/tools/inspection.js';
import type { SitemapSummary } from '../../../src/core/tools/sitemaps.js';
import { fmtInt } from '../../../src/core/format.js';
import { runTool } from '../api.js';
import { DataTable, type Column } from '../components/table.js';
import { Badge, Card, ErrorBox, Loading, Notice } from '../components/ui.js';
import { useAsync } from '../state.js';
import type { PageProps } from './overview.js';

const date = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

export function Indexing({ site }: PageProps) {
  const sitemaps = useAsync(() => runTool('list_sitemaps', { site_url: site }), [site]);
  const columns: Column<SitemapSummary>[] = [
    { label: 'Sitemap', render: (s) => <span class="break">{s.path}</span>, csv: (s) => s.path },
    {
      label: 'Type',
      render: (s) => (s.is_index ? 'index' : (s.type ?? '–')),
      csv: (s) => (s.is_index ? 'index' : s.type),
    },
    {
      label: 'Submitted URLs',
      numeric: true,
      render: (s) => fmtInt(s.submitted),
      csv: (s) => s.submitted,
    },
    {
      label: 'Errors',
      numeric: true,
      render: (s) => (s.errors ? <Badge tone="error">{s.errors}</Badge> : '0'),
      csv: (s) => s.errors,
    },
    {
      label: 'Warnings',
      numeric: true,
      render: (s) => (s.warnings ? <Badge tone="warn">{s.warnings}</Badge> : '0'),
      csv: (s) => s.warnings,
    },
    { label: 'Last read', render: (s) => date(s.last_downloaded), csv: (s) => s.last_downloaded },
    {
      label: 'Status',
      render: (s) =>
        s.is_pending ? (
          <Badge>pending</Badge>
        ) : s.errors ? (
          <Badge tone="error">errors</Badge>
        ) : (
          <Badge tone="ok">ok</Badge>
        ),
      csv: (s) => (s.is_pending ? 'pending' : s.errors ? 'errors' : 'ok'),
    },
  ];

  return (
    <>
      <h1>Indexing</h1>
      <Card title="Sitemaps">
        {sitemaps.error ? (
          <ErrorBox error={sitemaps.error} onRetry={sitemaps.reload} />
        ) : !sitemaps.data ? (
          <Loading />
        ) : (
          <DataTable
            caption="Sitemaps"
            columns={columns}
            rows={sitemaps.data.sitemaps}
            csvName="sitemaps"
            footer="Google no longer reports indexed counts per sitemap; inspect URLs below to check index status."
            empty="No sitemaps submitted for this property."
          />
        )}
      </Card>
      <Inspector site={site} />
    </>
  );
}

function Inspector({ site }: { site: string }) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<{
    loading: boolean;
    result?: InspectionSummary;
    error?: string;
  }>({ loading: false });

  async function inspect(e: Event) {
    e.preventDefault();
    setState({ loading: true });
    try {
      setState({
        loading: false,
        result: await runTool('inspect_url', { url: url.trim(), site_url: site }),
      });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const r = state.result;
  return (
    <Card title="URL Inspection">
      <form class="inline-form" onSubmit={inspect}>
        <label for="inspect-url" class="sr-only">
          URL to inspect
        </label>
        <input
          id="inspect-url"
          type="url"
          required
          placeholder="https://example.com/page"
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn btn-primary" disabled={state.loading}>
          {state.loading ? 'Inspecting…' : 'Inspect'}
        </button>
      </form>
      <p class="small muted">
        Uses 1 of the property's 2,000 daily URL Inspection calls. Shows the indexed version, not a
        live test.
      </p>
      {state.error && <ErrorBox error={state.error} />}
      {r && (
        <dl class="facts">
          <dt>Verdict</dt>
          <dd>
            <Badge tone={r.verdict === 'PASS' ? 'ok' : r.verdict === 'FAIL' ? 'error' : 'warn'}>
              {r.verdict}
            </Badge>{' '}
            {r.coverage_state}
          </dd>
          <dt>Indexing</dt>
          <dd>
            {r.indexing_state ?? '–'} · robots.txt {r.robots_txt_state ?? '–'} · fetch{' '}
            {r.page_fetch_state ?? '–'}
          </dd>
          <dt>Last crawl</dt>
          <dd>
            {r.last_crawl_time ?? 'never'}
            {r.crawled_as ? ` (${r.crawled_as.toLowerCase()} crawler)` : ''}
          </dd>
          <dt>Canonical</dt>
          <dd>
            Google: <span class="break">{r.google_canonical ?? '–'}</span>
            <br />
            Declared: <span class="break">{r.user_canonical ?? '–'}</span>
            {r.canonical_mismatch && (
              <Notice tone="warn">
                Google chose a different canonical than the page declares.
              </Notice>
            )}
          </dd>
          {r.sitemaps.length > 0 && (
            <>
              <dt>Sitemaps</dt>
              <dd class="break">{r.sitemaps.join(', ')}</dd>
            </>
          )}
          {r.rich_results && (
            <>
              <dt>Rich results</dt>
              <dd>
                {r.rich_results.verdict}
                <ul class="plain">
                  {r.rich_results.items.map((i) => (
                    <li>
                      {i.type}
                      {i.name ? ` (${i.name})` : ''}
                      {i.issues.length ? `: ${i.issues.join('; ')}` : ''}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {r.inspection_link && (
            <>
              <dt>Search Console</dt>
              <dd>
                <a href={r.inspection_link} target="_blank" rel="noopener noreferrer">
                  Open inspection
                </a>
              </dd>
            </>
          )}
        </dl>
      )}
    </Card>
  );
}
