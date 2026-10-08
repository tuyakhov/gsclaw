import type { ComponentChildren } from 'preact';

export interface Column<T> {
  label: string;
  render: (row: T) => ComponentChildren;
  /** Plain value for CSV export; omit to leave the column out of the export. */
  csv?: (row: T) => string | number | null | undefined;
  numeric?: boolean;
}

function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const exported = columns.filter((c) => c.csv);
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [exported.map((c) => escape(c.label)).join(',')];
  for (const row of rows) lines.push(exported.map((c) => escape(c.csv!(row))).join(','));
  return `${lines.join('\n')}\n`;
}

export function downloadCsv<T>(name: string, columns: Column<T>[], rows: T[]): void {
  const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gsclaw-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataTable<T>(props: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  empty?: ComponentChildren;
  csvName?: string;
  footer?: ComponentChildren;
}) {
  if (props.rows.length === 0) return <p class="empty">{props.empty ?? 'No rows.'}</p>;
  return (
    <div class="table-wrap">
      <div class="table-scroll" tabIndex={0} role="region" aria-label={props.caption}>
        <table>
          <caption class="sr-only">{props.caption}</caption>
          <thead>
            <tr>
              {props.columns.map((c) => (
                <th scope="col" class={c.numeric ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr>
                {props.columns.map((c) => (
                  <td class={c.numeric ? 'num' : undefined}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(props.footer || props.csvName) && (
        <div class="table-foot">
          <span>{props.footer}</span>
          {props.csvName && (
            <button
              type="button"
              class="btn btn-small"
              onClick={() => downloadCsv(props.csvName!, props.columns, props.rows)}
            >
              Export CSV
            </button>
          )}
        </div>
      )}
    </div>
  );
}
