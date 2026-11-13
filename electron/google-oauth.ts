import { createHash, timingSafeEqual } from "node:crypto";

export function validateGoogleOAuthCallback(rawUrl: string, expectedRedirect: string, expectedState: string): { code: string } {
  const url = new URL(rawUrl);
  const redirect = new URL(expectedRedirect);
  if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname) || redirect.pathname !== "/" || redirect.search || redirect.hash || redirect.username || redirect.password)
    throw new Error("Google OAuth redirect must be a Desktop loopback IP URL with no path.");
  if (url.origin !== redirect.origin || url.pathname !== "/" || url.hash || url.username || url.password)
    throw new Error("Google callback did not match the expected loopback redirect URI.");
  const states = url.searchParams.getAll("state");
  if (states.length !== 1) throw new Error("Google authorization state was missing or duplicated.");
  const received = Buffer.from(states[0]);
  const expected = Buffer.from(expectedState);
  if (!expected.length || received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new Error("Google authorization state did not match.");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (codes.length === 1 && errors.length === 0 && codes[0]) return { code: codes[0] };
  if (errors.length === 1 && codes.length === 0) {
    if (errors[0] === "access_denied") throw new Error("Google authorization was canceled or denied.");
    throw new Error(`Google authorization failed: ${errors[0]}`);
  }
  throw new Error("Google callback must contain exactly one authorization code or OAuth error.");
}

export function createGoogleCodeChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("Invalid Google OAuth PKCE code verifier.");
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function googleTokenRequestBody(options: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientSecret?: string;
}): URLSearchParams {
  const { clientId, code, redirectUri, codeVerifier, clientSecret } = options;
  if (!clientId || clientId.trim() !== clientId || clientId.length > 500) throw new Error("Invalid Google OAuth client ID.");
  if (!code || code.length > 4096 || /\s/.test(code)) throw new Error("Missing or invalid Google authorization code.");
  createGoogleCodeChallenge(codeVerifier);
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname) || !redirect.port || redirect.pathname !== "/" || redirect.search || redirect.hash)
    throw new Error("Invalid Google Desktop OAuth loopback redirect URI.");
  if (clientSecret !== undefined && (typeof clientSecret !== "string" || clientSecret.length > 2048)) throw new Error("Invalid optional Google OAuth client secret.");
  const body = new URLSearchParams({ code, client_id: clientId, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier });
  if (clientSecret) body.set("client_secret", clientSecret);
  return body;
}

export async function exchangeGoogleAuthorizationCode(options: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientSecret?: string;
  fetcher?: typeof fetch;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number; [key: string]: unknown }> {
  const body = googleTokenRequestBody(options);
  const fetcher = options.fetcher || fetch;
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error: any) {
    throw new Error(`Could not reach Google's OAuth token endpoint: ${error?.message || "network request failed"}`);
  }
  let data: any;
  try { data = await response.json(); }
  catch { throw new Error(`Google token exchange returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const detail = String(data?.error_description || data?.error || `HTTP ${response.status}`).replace(/[\r\n\t]+/g, " ").slice(0, 400);
    throw new Error(`Google token exchange failed (${response.status}): ${detail}`);
  }
  if (!data || typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 8192 ||
      typeof data.refresh_token !== "string" || !data.refresh_token || data.refresh_token.length > 8192 ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0)
    throw new Error("Google returned an incomplete token response. Reconnect and grant offline access to receive a refresh token.");
  return data;
}
