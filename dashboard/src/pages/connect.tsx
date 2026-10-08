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

function snippets(info: ConnectInfo): Snippet[] {
  const url = info.mcp_url;
  const list: Snippet[] = [];
  if (info.secret_path_enabled) {
    list.push({
      id: 'claude-ai',
      title: 'claude.ai, Claude Desktop & mobile',
      description:
        'Settings → Connectors → Add custom connector. Paste this URL as the server URL and leave the OAuth fields empty. Connectors sync to Claude Desktop and mobile.',
      build: (t) => `${url}/${t}`,
      needsToken: true,
    });
  }
  list.push(
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
        JSON.stringify(
          { mcpServers: { gsclaw: { url, headers: { Authorization: `Bearer ${t}` } } } },
          null,
          2,
        ),
      needsToken: true,
    },
    {
      id: 'vscode',
      title: 'VS Code',
      description: 'Add to .vscode/mcp.json. VS Code prompts for the token and stores it securely.',
      lang: 'json',
      build: () =>
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
      needsToken: false,
    },
  );
  if (info.secret_path_enabled) {
    list.push({
      id: 'chatgpt',
      title: 'ChatGPT',
      description:
        'Add a custom MCP server (developer mode / plugins) with this URL and "No authentication".',
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
      JSON.stringify(
        {
          mcpServers: {
            gsclaw: {
              command: 'npx',
              args: ['-y', 'gsclaw'],
              env: { GOOGLE_APPLICATION_CREDENTIALS: '/path/to/service-account.json' },
            },
          },
        },
        null,
        2,
      ),
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

  const shown = (s: Snippet) => s.build(revealed && secret.token ? secret.token : MASK);
  return (
    <>
      <h1>Connect</h1>
      <p class="sub">
        Your MCP endpoint is <code>{info.data.mcp_url}</code>. Snippets include your access token,
        which is hidden until you reveal it; copying always includes the real value.
      </p>
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
      {!info.data.secret_path_enabled && (
        <Notice tone="warn">
          The secret path is disabled (GSCLAW_SECRET_PATH=false), so clients that can't send
          headers, such as claude.ai, can't connect yet.
        </Notice>
      )}
      {snippets(info.data).map((s) => (
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
      <Notice>
        Treat these like passwords. Anyone with the token can read this deployment's Search Console
        data. Rotate it by changing GSCLAW_ACCESS_TOKEN and redeploying; that also signs everyone
        out of this dashboard.
      </Notice>
    </>
  );
}
