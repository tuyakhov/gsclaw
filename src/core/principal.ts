/** GSClaw's own OAuth scopes (what a client may do), mapped to Google scopes internally. */
export const SCOPE_READ = 'gsc:read';
export const SCOPE_WRITE = 'gsc:write';

/** Who is making a request, however they authenticated. */
export interface Principal {
  /** "owner" = the deployment owner (service-account mode); "user" = a Google user (OAuth mode). */
  kind: 'owner' | 'user';
  /** Stable subject: "owner", or the Google account's `sub`. */
  sub: string;
  email?: string;
  /** Granted GSClaw scopes. */
  scopes: string[];
  via: 'static_token' | 'secret_path' | 'oauth' | 'session' | 'stdio';
  /** OAuth client the token was issued to, if any. */
  clientId?: string;
  clientName?: string;
  /** The user's Google credentials (OAuth mode only). */
  google?: {
    accessToken?: string;
    /** Seconds since epoch. */
    expiresAt?: number;
    refreshToken: string;
    scope: string[];
  };
}

export const OWNER: Principal = {
  kind: 'owner',
  sub: 'owner',
  scopes: [SCOPE_READ, SCOPE_WRITE],
  via: 'static_token',
};
