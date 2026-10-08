import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Logo } from '../components/logo.js';
import { Notice } from '../components/ui.js';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
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

  return (
    <main class="login" id="main">
      <form class="card login-card" onSubmit={submit}>
        <div class="brand">
          <Logo />
          <span>GSClaw</span>
        </div>
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
