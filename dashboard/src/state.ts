import { useCallback, useEffect, useState } from 'preact/hooks';

export interface AsyncState<T> {
  loading: boolean;
  data?: T;
  error?: string;
  reload: () => void;
}

/** Runs `fn` whenever `deps` change; keeps the previous data visible while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ loading: boolean; data?: T; error?: string }>({
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ data: s.data, loading: true }));
    fn().then(
      (data) => alive && setState({ loading: false, data }),
      (error: unknown) =>
        alive &&
        setState({ loading: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { ...state, reload };
}

/** localStorage that never throws (private windows, blocked storage). */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`gsclaw:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(`gsclaw:${key}`);
      else localStorage.setItem(`gsclaw:${key}`, value);
    } catch {
      // ignore
    }
  },
};

export function usePersisted(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => storage.get(key) ?? fallback);
  return [
    value,
    (v: string) => {
      storage.set(key, v);
      setValue(v);
    },
  ];
}

export const ROUTES = [
  'overview',
  'opportunities',
  'indexing',
  'activity',
  'connect',
  'setup',
] as const;
export type Route = (typeof ROUTES)[number];

function readRoute(fallback: Route): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : fallback;
}

export function useRoute(fallback: Route): Route {
  const [route, setRoute] = useState<Route>(() => readRoute(fallback));
  useEffect(() => {
    const onChange = () => setRoute(readRoute(fallback));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, [fallback]);
  return route;
}

export type Theme = 'system' | 'light' | 'dark';

/** Effective theme ('light' | 'dark'), following the OS when set to system. */
export function useTheme(): [Theme, (t: Theme) => void, 'light' | 'dark'] {
  const [theme, setTheme] = usePersisted('theme', 'system');
  const media = matchMedia('(prefers-color-scheme: dark)');
  const [systemDark, setSystemDark] = useState(media.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [media]);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const effective =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : (theme as 'light' | 'dark');
  return [theme as Theme, setTheme, effective];
}

/** Copies text, falling back to a hidden textarea where the async clipboard API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export function toast(message: string): void {
  dispatchEvent(new CustomEvent('gsclaw:toast', { detail: message }));
}
