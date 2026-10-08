import { useEffect } from 'preact/hooks';
import type { ActivityEntry } from '../../../src/core/activity.js';
import { api, type Activity as ActivityData } from '../api.js';
import { DataTable, type Column } from '../components/table.js';
import { Badge, Card, ErrorBox, Loading, Notice } from '../components/ui.js';
import { useAsync } from '../state.js';

const columns: Column<ActivityEntry>[] = [
  { label: 'Time', render: (e) => new Date(e.time).toLocaleString(), csv: (e) => e.time },
  { label: 'Client', render: (e) => e.client, csv: (e) => e.client },
  { label: 'Tool', render: (e) => <code>{e.tool}</code>, csv: (e) => e.tool },
  {
    label: 'Property / URL',
    render: (e) => <span class="break">{e.site ?? '–'}</span>,
    csv: (e) => e.site,
  },
  { label: 'Latency', numeric: true, render: (e) => `${e.ms} ms`, csv: (e) => e.ms },
  {
    label: 'Result',
    render: (e) =>
      e.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="error">{e.error_kind ?? 'error'}</Badge>,
    csv: (e) => (e.ok ? 'ok' : (e.error_kind ?? 'error')),
  },
];

export function Activity() {
  const state = useAsync(() => api<ActivityData>('/api/activity'), []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') state.reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [state.reload]);

  return (
    <>
      <h1>Activity</h1>
      <p class="sub">
        What your AI clients are doing with your data: recent MCP tool calls. Only metadata is kept,
        never responses.
      </p>
      {state.data && !state.data.persistent && (
        <Notice>
          In-memory and per server instance: the list resets when the server restarts, and
          serverless platforms may run several instances, each with its own list.
        </Notice>
      )}
      <Card
        title="Recent tool calls"
        actions={
          <button
            type="button"
            class="btn btn-small"
            onClick={state.reload}
            disabled={state.loading}
          >
            Refresh
          </button>
        }
      >
        {state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : !state.data ? (
          <Loading />
        ) : (
          <DataTable
            caption="Recent MCP tool calls"
            columns={columns}
            rows={state.data.entries}
            csvName="activity"
            empty="No tool calls yet on this instance. Connect a client from the Connect page and ask it something."
          />
        )}
      </Card>
    </>
  );
}
