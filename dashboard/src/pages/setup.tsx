import type { Property } from '../../../src/core/gsc/sites.js';
import { api, type Status } from '../api.js';
import { DataTable, type Column } from '../components/table.js';
import { Badge, Card, CopyButton, ErrorBox, Loading, Notice } from '../components/ui.js';
import { useAsync } from '../state.js';

const PERMISSION: Record<string, string> = {
  owner: 'Owner',
  full: 'Full',
  restricted: 'Restricted',
  unverified: 'Unverified (no data)',
  unknown: 'Unknown',
};

const propertyColumns: Column<Property>[] = [
  {
    label: 'Property',
    render: (p) => <span class="break">{p.site_url}</span>,
    csv: (p) => p.site_url,
  },
  {
    label: 'Type',
    render: (p) => (p.type === 'domain' ? 'Domain' : 'URL prefix'),
    csv: (p) => p.type,
  },
  {
    label: 'Permission',
    render: (p) => (
      <Badge tone={p.has_access ? 'ok' : 'warn'}>{PERMISSION[p.permission_level]}</Badge>
    ),
    csv: (p) => p.permission_level,
  },
];

export function Setup() {
  const state = useAsync(() => api<Status>('/api/status'), []);
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  const s = state.data;
  if (!s) return <Loading label="Checking your setup…" />;

  const isServiceAccount = s.identity.kind === 'service_account';
  const oauth = s.oauth;
  return (
    <>
      <h1>Setup & health</h1>
      {s.update_available && (
        <Notice>
          GSClaw {s.latest_version} is available (you run {s.version}).{' '}
          <a
            href="https://github.com/tuyakhov/gsclaw/releases"
            target="_blank"
            rel="noopener noreferrer"
          >
            See what's new
          </a>
          .
        </Notice>
      )}
      {s.warnings.map((w) => (
        <Notice tone="warn">{w}</Notice>
      ))}

      <div class="grid-2">
        <Card
          title="Google connection"
          actions={
            <button
              type="button"
              class="btn btn-small"
              onClick={state.reload}
              disabled={state.loading}
            >
              {state.loading ? 'Checking…' : 'Check again'}
            </button>
          }
        >
          {s.google.ok ? (
            <p>
              <Badge tone="ok">Connected</Badge> Search Console API answered in{' '}
              {s.google.latency_ms} ms; {s.google.properties.filter((p) => p.has_access).length}{' '}
              readable properties.
            </p>
          ) : (
            <ErrorBox error={s.google.error} />
          )}
          <dl class="facts">
            <dt>{isServiceAccount ? 'Service account' : 'Google account'}</dt>
            <dd class="row">
              <code class="break">{s.identity.email}</code>
              <CopyButton small text={s.identity.email} />
            </dd>
          </dl>
          {isServiceAccount && (
            <p class="small muted">
              Add this address as a user on each property: Search Console → Settings → Users and
              permissions → Add user. Restricted is enough for reading; sitemap changes need Full.
            </p>
          )}
        </Card>

        <Card title="Server">
          <dl class="facts">
            <dt>Version</dt>
            <dd>
              {s.version}
              {s.latest_version && !s.update_available && <span class="muted"> (latest)</span>}
            </dd>
            <dt>Platform</dt>
            <dd>{s.platform}</dd>
            <dt>Auth mode</dt>
            <dd>{s.auth_mode === 'service_account' ? 'Service account' : 'Google OAuth'}</dd>
            <dt>Writes</dt>
            <dd>
              {s.writes_enabled ? (
                <Badge tone="warn">Enabled: sitemap submit/delete</Badge>
              ) : (
                <Badge tone="ok">Disabled (read-only)</Badge>
              )}
            </dd>
            {!oauth && (
              <>
                <dt>Secret path</dt>
                <dd>{s.secret_path_enabled ? 'Enabled (/mcp/<token>)' : 'Disabled'}</dd>
              </>
            )}
            <dt>Rate limit</dt>
            <dd>{s.rate_limit_per_minute ? `${s.rate_limit_per_minute} requests/min` : 'Off'}</dd>
            <dt>Public URL</dt>
            <dd class="break">{s.public_base_url ?? location.origin}</dd>
          </dl>
        </Card>
      </div>

      {oauth && (
        <Card title="Google sign-in">
          <dl class="facts">
            <dt>Redirect URI</dt>
            <dd class="row">
              <code class="break">{oauth.redirect_uri}</code>
              <CopyButton small text={oauth.redirect_uri} />
            </dd>
            <dt>Who can sign in</dt>
            <dd>
              {oauth.open_to_anyone ? (
                <Badge tone="warn">Any Google account</Badge>
              ) : (
                [
                  oauth.allowed_domains.length > 0 &&
                    `Accounts at ${oauth.allowed_domains.join(', ')}`,
                  oauth.allowed_email_count > 0 &&
                    `${oauth.allowed_email_count} allowed email address${oauth.allowed_email_count === 1 ? '' : 'es'}`,
                ]
                  .filter(Boolean)
                  .join('; ')
              )}
            </dd>
          </dl>
          <p class="small muted">
            Register the redirect URI on your OAuth client in Google Cloud Console → APIs & Services
            → Credentials. Everyone signs in with their own Google account and sees only the
            properties that account can access in Search Console.
          </p>
        </Card>
      )}

      <Card title="Properties">
        {s.google.ok ? (
          <DataTable
            caption="Search Console properties"
            columns={propertyColumns}
            rows={s.google.properties}
            empty={
              <Notice tone="warn">
                {isServiceAccount
                  ? `No properties are visible yet. Add ${s.identity.email} as a user on your Search Console properties, then check again.`
                  : `${s.identity.email} can't see any Search Console properties. Ask a property owner to add this account in Search Console → Settings → Users and permissions.`}
              </Notice>
            }
          />
        ) : (
          <p class="muted">Fix the Google connection above to list properties.</p>
        )}
      </Card>
    </>
  );
}
