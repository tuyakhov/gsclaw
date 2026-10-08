import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtPct, fmtPos } from '../../../src/core/format.js';
import { copyText, toast } from '../state.js';

export function Card(props: {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`card ${props.class ?? ''}`}>
      {(props.title || props.actions) && (
        <header class="card-head">
          {props.title && <h2>{props.title}</h2>}
          {props.actions && <div class="card-actions">{props.actions}</div>}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p class="loading" role="status">
      <span class="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function Notice(props: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  children: ComponentChildren;
}) {
  const tone = props.tone ?? 'info';
  return (
    <div class={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {props.children}
    </div>
  );
}

/** Shows a server error message, preserving its line breaks (Google's advice is multi-line). */
export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Notice tone="error">
      <p class="pre-line">{error}</p>
      {onRetry && (
        <button type="button" class="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      )}
    </Notice>
  );
}

export function CopyButton(props: {
  text: string | (() => Promise<string>);
  label?: string;
  title?: string;
  small?: boolean;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      class={`btn ${props.small ? 'btn-small' : ''}`}
      title={props.title}
      onClick={async () => {
        const text = typeof props.text === 'string' ? props.text : await props.text();
        await copyText(text);
        setDone(true);
        toast('Copied to clipboard');
        timer.current = window.setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : (props.label ?? 'Copy')}
    </button>
  );
}

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          class={o.value === props.value ? 'active' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Accessible tabs: arrow keys move between tabs, only the active tab is in the tab order. */
export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  tabs: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = props.tabs.findIndex((t) => t.value === props.value);
  const move = (delta: number) => {
    const next = (index + delta + props.tabs.length) % props.tabs.length;
    props.onChange(props.tabs[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label={props.label}>
      {props.tabs.map((t, i) => (
        <button
          type="button"
          role="tab"
          id={`tab-${t.value}`}
          aria-selected={t.value === props.value}
          aria-controls={`panel-${t.value}`}
          tabIndex={t.value === props.value ? 0 : -1}
          ref={(el) => {
            refs.current[i] = el;
          }}
          onClick={() => props.onChange(t.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') move(1);
            else if (e.key === 'ArrowLeft') move(-1);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A signed change with an accessible direction. `higherIsBetter` controls the colour. */
export function Delta({
  value,
  format,
  higherIsBetter = true,
}: {
  value: number | null;
  format: (v: number) => string;
  higherIsBetter?: boolean;
}) {
  if (value === null || !Number.isFinite(value)) return <span class="delta">–</span>;
  if (value === 0) return <span class="delta">0</span>;
  const good = higherIsBetter ? value > 0 : value < 0;
  return (
    <span class={`delta ${good ? 'up' : 'down'}`}>
      <span aria-hidden="true">{value > 0 ? '▲' : '▼'}</span>
      <span class="sr-only">{value > 0 ? 'up' : 'down'}</span> {format(Math.abs(value))}
    </span>
  );
}

export const pct = (v: number) => fmtPct(v);
export const pos = (v: number | null) => fmtPos(v);

export function Badge(props: {
  tone?: 'ok' | 'warn' | 'error' | 'muted';
  children: ComponentChildren;
}) {
  return <span class={`badge badge-${props.tone ?? 'muted'}`}>{props.children}</span>;
}

export function Toaster() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const onToast = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(null), 2000);
    };
    addEventListener('gsclaw:toast', onToast);
    return () => removeEventListener('gsclaw:toast', onToast);
  }, []);
  return (
    <div class="toast-region" role="status" aria-live="polite">
      {message && <div class="toast">{message}</div>}
    </div>
  );
}
