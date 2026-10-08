import { useRef, useState } from 'preact/hooks';
import { api, type ConnectInfo } from '../api.js';
import { Card, CopyButton, ErrorBox, Loading, Notice } from '../components/ui.js';
import { useAsync } from '../state.js';

const MASK = '••••••••••••••••';

/** Fetches the access token only when the user reveals or copies a snippet. */
function useSecret() {
  const [token, setToken] = useState<string | null>(null);
  const pending = useRef<Promise<string>>();
  const load = () => {
    pending.current ??= api<{ access_token: string }>('/api/connect/secret').then((r) => {
      setToken(r.access_token);
      return r.access_token;
    });
    return pending.current;
  };
  return { token, load };
}

interface Snippet {
  id: string;
  title: string;
  description: string;
  lang?: string;
  build: (token: string) => string;
  needsToken: boolean;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Google OAuth mode: every client signs in with Google, so snippets carry no secrets. */
function oauthSnippets(url: string): Snippet[] {
  return [
    {
      id: 'claude-ai',
      title: 'claude.ai, Claude Desktop & mobile',
      description:
        'Settings → Connectors → Add custom connector. Paste this URL and click Connect; Claude opens a Google sign-in. Connectors sync to Claude Desktop and mobile.',
      build: () => url,
      needsToken: false,
    },
    {
      id: 'claude-code',
      title: 'Claude Code',
      description: 'Run in your terminal, then run /mcp in Claude Code to sign in with Google.',
      lang: 'bash',
      build: () => `claude mcp add --transport http gsclaw ${url}`,
      needsToken: false,
    },
    {
      id: 'cursor',
      title: 'Cursor',
      description:
        'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project). Cursor asks you to sign in.',
      lang: 'json',
      build: () => json({ mcpServers: { gsclaw: { url } } }),
      needsToken: false,
    },
    {
      id: 'vscode',
      title: 'VS Code',
      description: 'Add to .vscode/mcp.json. VS Code asks you to sign in when the server starts.',
      lang: 'json',
      build: () => json({ servers: { gsclaw: { type: 'http', url } } }),
      needsToken: false,
    },
    {
      id: 'chatgpt',
      title: 'ChatGPT',
      description:
        'Add a custom connector (developer mode) with this URL and OAuth authentication.',
      build: () => url,
      needsToken: false,
    },
  ];
}

/** Service-account mode: OAuth sign-in with the access token, headers, or the secret URL. */
function serviceAccountSnippets(info: ConnectInfo): Snippet[] {
  const url = info.mcp_url;
  const list: Snippet[] = [
    {
      id: 'claude-ai',
      title: 'claude.ai, Claude Desktop & mobile',
      description:
        'Settings → Connectors → Add custom connector. Paste this URL and click Connect; on the GSClaw page that opens, enter your access token to approve. Connectors sync to Claude Desktop and mobile.',
      build: () => url,
      needsToken: false,
    },
    {
      id: 'claude-code',
      title: 'Claude Code',
      description: 'Run in your terminal (add --scope user to use it in every project).',
      lang: 'bash',
      build: (t) =>
        `claude mcp add --transport http gsclaw ${url} --header "Authorization: Bearer ${t}"`,
      needsToken: true,
    },
    {
      id: 'cursor',
      title: 'Cursor',
      description: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).',
      lang: 'json',
      build: (t) =>
        json({ mcpServers: { gsclaw: { url, headers: { Authorization: `Bearer ${t}` } } } }),
      needsToken: true,
    },
    {
      id: 'vscode',
      title: 'VS Code',
      description: 'Add to .vscode/mcp.json. VS Code prompts for the token and stores it securely.',
      lang: 'json',
      build: () =>
        json({
          inputs: [
            {
              type: 'promptString',
              id: 'gsclaw-token',
              description: 'GSClaw access token',
              password: true,
            },
          ],
          servers: {
            gsclaw: {
              type: 'http',
              url,
              headers: { Authorization: 'Bearer ${input:gsclaw-token}' },
            },
          },
        }),
      needsToken: false,
    },
    {
      id: 'chatgpt',
      title: 'ChatGPT',
      description:
        'Add a custom connector (developer mode) with this URL and OAuth authentication, then approve with your access token.',
      build: () => url,
      needsToken: false,
    },
  ];
  if (info.secret_path_enabled) {
    list.push({
      id: 'secret-url',
      title: 'Secret URL (clients without OAuth or custom headers)',
      description:
        'The token is part of the URL, so anyone who sees it has access. Prefer the options above when your client supports them.',
      build: (t) => `${url}/${t}`,
      needsToken: true,
    });
  }
  list.push({
    id: 'stdio',
    title: 'Local (stdio): Claude Desktop config & other clients',
    description:
      'Runs GSClaw on your machine instead of this deployment. Uses your service-account key file directly; no access token needed.',
    lang: 'json',
    build: () =>
      json({
        mcpServers: {
          gsclaw: {
            command: 'npx',
            args: ['-y', 'gsclaw'],
            env: { GOOGLE_APPLICATION_CREDENTIALS: '/path/to/service-account.json' },
          },
        },
      }),
    needsToken: false,
  });
  return list;
}

export function Connect() {
  const info = useAsync(() => api<ConnectInfo>('/api/connect'), []);
  const secret = useSecret();
  const [revealed, setRevealed] = useState(false);

  if (info.error) return <ErrorBox error={info.error} onRetry={info.reload} />;
  if (!info.data) return <Loading />;

  const isOAuth = info.data.auth_mode === 'oauth';
  const list = isOAuth ? oauthSnippets(info.data.mcp_url) : serviceAccountSnippets(info.data);
  const hasSecrets = list.some((s) => s.needsToken);
  const shown = (s: Snippet) => s.build(revealed && secret.token ? secret.token : MASK);
  return (
    <>
      <h1>Connect</h1>
      <p class="sub">
        Your MCP endpoint is <code>{info.data.mcp_url}</code>.{' '}
        {isOAuth
          ? 'Each person signs in with their own Google account and only sees the properties that account can access.'
          : 'Some snippets include your access token, which is hidden until you reveal it; copying always includes the real value.'}
      </p>
      {hasSecrets && (
        <div class="row">
          <button
            type="button"
            class="btn"
            aria-pressed={revealed}
            onClick={async () => {
              if (!revealed) await secret.load();
              setRevealed(!revealed);
            }}
          >
            {revealed ? 'Hide secrets' : 'Reveal secrets'}
          </button>
        </div>
      )}
      {list.map((s) => (
        <Card
          title={s.title}
          actions={
            <CopyButton
              small
              text={async () => s.build(s.needsToken ? await secret.load() : MASK)}
            />
          }
        >
          <p class="small muted">{s.description}</p>
          <pre class="code" aria-label={`${s.title} snippet`}>
            <code>{shown(s)}</code>
          </pre>
        </Card>
      ))}
      {isOAuth ? (
        <Notice>
          Access lasts until you disconnect the client, or remove GSClaw under Google Account →
          Security → Third-party connections. Changing GSCLAW_ENCRYPTION_KEY signs everyone out.
        </Notice>
      ) : (
        <Notice>
          Treat the access token like a password: anyone with it can read this deployment's Search
          Console data. Rotate it by changing GSCLAW_ACCESS_TOKEN and redeploying; that also
          disconnects every OAuth client and signs everyone out of this dashboard.
        </Notice>
      )}
    </>
  );
}
