export interface ActivityEntry {
  time: string;
  /** Best-effort client name (from the User-Agent or transport). */
  client: string;
  tool: string;
  site: string | null;
  ms: number;
  ok: boolean;
  error_kind?: string;
  /** Signed-in Google user (OAuth mode); used to show each person only their own calls. */
  user?: string;
}

/**
 * Recent tool calls for the dashboard's trust view: metadata only, never arguments beyond the
 * property or response payloads. In-memory and per instance: serverless platforms may run several
 * instances, and each keeps its own list.
 */
export class ActivityLog {
  readonly persistent = false;
  private readonly entries: ActivityEntry[] = [];

  constructor(private readonly capacity = 200) {}

  record(entry: ActivityEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  list(limit = this.capacity): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}

const KNOWN_CLIENTS: [RegExp, string][] = [
  [/claude-code|claude code/i, 'Claude Code'],
  [/claude/i, 'Claude'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/cursor/i, 'Cursor'],
  [/visual studio code|vscode|copilot/i, 'VS Code'],
  [/inspector/i, 'MCP Inspector'],
  [/openclaw/i, 'OpenClaw'],
  [/gemini/i, 'Gemini CLI'],
  [/codex/i, 'Codex'],
];

/** Maps a User-Agent to a short client label. */
export function clientLabel(userAgent: string | null): string {
  if (!userAgent) return 'unknown';
  for (const [pattern, label] of KNOWN_CLIENTS) if (pattern.test(userAgent)) return label;
  return userAgent.split(/[\s/]/)[0]!.slice(0, 40) || 'unknown';
}
