import 'uplot/dist/uPlot.min.css';
import './styles.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, runTool, setUnauthorizedHandler } from './api.js';
import { Logo } from './components/logo.js';
import { ErrorBox, Loading, Notice, Toaster } from './components/ui.js';
import { Activity } from './pages/activity.js';
import { Connect } from './pages/connect.js';
import { Indexing } from './pages/indexing.js';
import { Login } from './pages/login.js';
import { Opportunities } from './pages/opportunities.js';
import { Overview } from './pages/overview.js';
import { Setup } from './pages/setup.js';
import {
  storage,
  useAsync,
  usePersisted,
  useRoute,
  useTheme,
  type Route,
  type Theme,
} from './state.js';

const NAV: { route: Route; label: string; needsProperty: boolean }[] = [
  { route: 'overview', label: 'Overview', needsProperty: true },
  { route: 'opportunities', label: 'Opportunities', needsProperty: true },
  { route: 'indexing', label: 'Indexing', needsProperty: true },
  { route: 'activity', label: 'Activity', needsProperty: false },
  { route: 'connect', label: 'Connect', needsProperty: false },
  { route: 'setup', label: 'Setup & health', needsProperty: false },
];

const RANGES = [
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_28_days', label: 'Last 28 days' },
  { value: 'last_3_months', label: 'Last 3 months' },
  { value: 'last_6_months', label: 'Last 6 months' },
  { value: 'last_12_months', label: 'Last 12 months' },
];

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System theme' },
  { value: 'light', label: 'Light theme' },
  { value: 'dark', label: 'Dark theme' },
];

function App() {
  const [session, setSession] = useState<'loading' | 'in' | 'out'>('loading');
  useEffect(() => {
    setUnauthorizedHandler(() => setSession('out'));
    api<{ authenticated: boolean }>('/api/session').then(
      (s) => setSession(s.authenticated ? 'in' : 'out'),
      () => setSession('out'),
    );
  }, []);

  if (session === 'loading') return <Loading label="Loading GSClaw…" />;
  if (session === 'out') return <Login onSignedIn={() => setSession('in')} />;
  return (
    <Dashboard
      onSignOut={async () => {
        await api('/api/session', { method: 'DELETE' }).catch(() => undefined);
        setSession('out');
      }}
    />
  );
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute(storage.get('site') ? 'overview' : 'setup');
  const [theme, setTheme, effectiveTheme] = useTheme();
  const [site, setSite] = usePersisted('site', '');
  const [range, setRange] = usePersisted('range', 'last_28_days');
  const sites = useAsync(() => runTool('list_sites', {}), []);

  const readable = (sites.data?.properties ?? []).filter((p) => p.has_access);
  const current =
    readable.find((p) => p.site_url === site)?.site_url ?? readable[0]?.site_url ?? '';
  useEffect(() => {
    if (current && current !== site) setSite(current);
  }, [current, site, setSite]);

  // Mobile menu: closes on navigation and Escape; focus moves into it when it opens.
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => setMenuOpen(false), [route]);
  useEffect(() => {
    if (menuOpen) firstLinkRef.current?.focus();
  }, [menuOpen]);
  const onNavKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && menuOpen) {
      setMenuOpen(false);
      toggleRef.current?.focus();
    }
  };

  const page = NAV.find((n) => n.route === route)!;
  const needsProperty = page.needsProperty;

  let content;
  if (needsProperty && sites.error)
    content = <ErrorBox error={sites.error} onRetry={sites.reload} />;
  else if (needsProperty && !sites.data) content = <Loading />;
  else if (needsProperty && !current)
    content = (
      <Notice tone="warn">
        This server can't read any Search Console property yet. See{' '}
        <a href="#/setup">Setup & health</a> for how to grant access.
      </Notice>
    );
  else {
    const props = { site: current, range, theme: effectiveTheme };
    content = {
      overview: <Overview {...props} />,
      opportunities: <Opportunities {...props} />,
      indexing: <Indexing {...props} />,
      activity: <Activity />,
      connect: <Connect />,
      setup: <Setup />,
    }[route];
  }

  return (
    <div class={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <nav class="nav" aria-label="Main" onKeyDown={onNavKeyDown}>
        <div class="nav-head">
          <a class="brand" href="#/overview">
            <Logo />
            <span>GSClaw</span>
          </a>
          <button
            ref={toggleRef}
            type="button"
            class="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="nav-panel"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <MenuIcon open={menuOpen} />
          </button>
        </div>
        <div class="nav-panel" id="nav-panel">
          <ul>
            {NAV.map((n, i) => (
              <li>
                <a
                  ref={i === 0 ? firstLinkRef : undefined}
                  href={`#/${n.route}`}
                  aria-current={n.route === route ? 'page' : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <div class="nav-footer">
            <label class="field">
              <span class="sr-only">Theme</span>
              <select
                value={theme}
                onChange={(e) => setTheme((e.target as HTMLSelectElement).value as Theme)}
              >
                {THEMES.map((t) => (
                  <option value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <button type="button" class="btn" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </nav>
      {menuOpen && (
        <div class="nav-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />
      )}
      <div class="content">
        {needsProperty && readable.length > 0 && (
          <header class="topbar">
            <label class="field">
              <span class="sr-only">Property</span>
              <select
                value={current}
                onChange={(e) => setSite((e.target as HTMLSelectElement).value)}
              >
                {readable.map((p) => (
                  <option value={p.site_url}>{p.site_url}</option>
                ))}
              </select>
            </label>
            {route !== 'indexing' && (
              <label class="field">
                <span class="sr-only">Date range</span>
                <select
                  value={range}
                  onChange={(e) => setRange((e.target as HTMLSelectElement).value)}
                >
                  {RANGES.map((r) => (
                    <option value={r.value}>{r.label}</option>
                  ))}
                </select>
              </label>
            )}
          </header>
        )}
        <main id="main" tabIndex={-1}>
          {content}
        </main>
      </div>
      <Toaster />
    </div>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {open ? (
        <path
          d="M6 6l12 12M18 6L6 18"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      ) : (
        <path
          d="M4 7h16M4 12h16M4 17h16"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      )}
    </svg>
  );
}

render(<App />, document.getElementById('app')!);
