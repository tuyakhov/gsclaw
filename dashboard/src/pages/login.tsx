import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Logo } from '../components/logo.js';
import { Notice } from '../components/ui.js';

const GOOGLE_ERRORS: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled.',
  google_error: 'Google sign-in failed. Please try again.',
  not_allowed:
    "This Google account isn't allowed to use this deployment. Ask its owner to add you to ALLOWED_GOOGLE_EMAILS or ALLOWED_GOOGLE_DOMAINS.",
  scope:
    'Search Console access was not granted. Sign in again and keep the Search Console permission ticked.',
};

/** Reads (and removes) the ?login_error= the server adds after a failed Google sign-in. */
function takeLoginError(): string | null {
  const params = new URLSearchParams(location.search);
  const code = params.get('login_error');
  if (!code) return null;
  params.delete('login_error');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  return GOOGLE_ERRORS[code] ?? GOOGLE_ERRORS.google_error!;
}

export function Login({
  login,
  onSignedIn,
}: {
  login: 'token' | 'google';
  onSignedIn: () => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(takeLoginError);
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/session', { body: { token } });
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const brand = (
    <div class="brand">
      <Logo />
      <span>GSClaw</span>
    </div>
  );

  if (login === 'google') {
    return (
      <main class="login" id="main">
        <div class="card login-card">
          {brand}
          <h1>Sign in</h1>
          <p class="muted">
            Sign in with the Google account you use for Search Console. You'll only see the
            properties that account can access.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <a class="btn btn-google" href="/oauth/google/start">
            <GoogleMark />
            Sign in with Google
          </a>
        </div>
      </main>
    );
  }

  return (
    <main class="login" id="main">
      <form class="card login-card" onSubmit={submit}>
        {brand}
        <h1>Sign in</h1>
        <p class="muted">
          Enter this deployment's access token (the GSCLAW_ACCESS_TOKEN you configured).
        </p>
        <label for="token">Access token</label>
        <input
          id="token"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" class="btn btn-primary" disabled={busy || !token}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

/** Google's "G" mark, per Google's sign-in branding guidelines. */
function GoogleMark() {
  return (
    <span class="google-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 48 48" focusable="false">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    </span>
  );
}
