import { timingSafeEqual } from 'node:crypto';

export function validateOAuthCallback(rawUrl: string, expectedRedirect: string, expectedState: string) {
  const url = new URL(rawUrl);
  const redirect = new URL(expectedRedirect);
  if (url.origin !== redirect.origin || url.pathname !== '/callback') throw new Error('Spotify callback did not come from the expected local redirect.');
  const states = url.searchParams.getAll('state');
  if (states.length !== 1) throw new Error('Spotify authorization state was missing or duplicated.');
  const got = Buffer.from(states[0]);
  const expected = Buffer.from(expectedState);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('Spotify authorization state did not match.');
  const codes = url.searchParams.getAll('code');
  const errors = url.searchParams.getAll('error');
  if (codes.length === 1 && errors.length === 0 && codes[0]) return { code: codes[0] };
  if (errors.length === 1 && codes.length === 0) throw new Error(`Spotify authorization was denied: ${errors[0]}`);
  throw new Error('Spotify callback did not contain exactly one authorization result.');
}

export function spotifyHttpError(status: number, retryAfter?: string | null, detail?: string) {
  const safeDetail = detail?.replace(/[\r\n\t]+/g, ' ').slice(0, 400).trim();
  if (status === 401) return `Spotify authorization failed (401). Reconnect Spotify if this persists.${safeDetail ? ` ${safeDetail}` : ''}`;
  if (status === 403) return `Spotify denied the operation (403). Check the granted playback scope, account eligibility, and device restrictions.${safeDetail ? ` Spotify: ${safeDetail}` : ''}`;
  if (status === 404) return `Spotify could not find the requested playback resource/device (404).${safeDetail ? ` Spotify: ${safeDetail}` : ''}`;
  if (status === 429) return `Spotify rate limit reached (429).${retryAfter ? ` Retry after ${retryAfter} seconds.` : ' Retry shortly.'}${safeDetail ? ` Spotify: ${safeDetail}` : ''}`;
  return `Spotify request failed (${status})${safeDetail ? `: ${safeDetail}` : ''}`;
}

/** Read a Spotify response exactly once, accepting 204/empty bodies and preserving non-JSON diagnostics. */
export async function readSpotifyResponse(response: Response): Promise<any | null> {
  if (response.status === 204) return null;
  let text: string;
  try { text = await response.text(); }
  catch (error: any) {
    if (!response.ok) throw new Error(spotifyHttpError(response.status, response.headers.get('Retry-After')));
    throw new Error(`Could not read Spotify response body (${response.status}): ${String(error?.message || error)}`);
  }
  if (response.status === 204 || text.trim() === '') {
    if (!response.ok) throw new Error(spotifyHttpError(response.status, response.headers.get('Retry-After')));
    return null;
  }
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* Some proxies and error pages return plain text. */ }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : [body?.error?.message || (typeof body?.error === 'string' ? body.error : ''), body?.error?.reason, body?.error_description, body?.message].filter(Boolean).join(': ') || JSON.stringify(body);
    throw new Error(spotifyHttpError(response.status, response.headers.get('Retry-After'), detail));
  }
  return body;
}

type SpotifyRequestOptions = {
  method: string;
  endpoint: string;
  body?: unknown;
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  onUnauthorized?: () => Promise<void>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

/** Spotify Web API request with one forced-refresh retry for 401 responses only. */
export async function requestSpotifyApi(options: SpotifyRequestOptions): Promise<any | null> {
  const fetcher = options.fetcher || fetch;
  let accessToken = await options.getAccessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetcher(`https://api.spotify.com/v1${options.endpoint}`, {
        method: options.method,
        headers: { Authorization: `Bearer ${accessToken}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      });
    } catch (error: any) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new Error(timeout ? `Spotify request timed out (${options.method} ${options.endpoint}).` : `Spotify network request failed (${options.method} ${options.endpoint}): ${String(error?.message || error)}`);
    }
    if (response.status === 401 && attempt === 0) {
      try { await response.body?.cancel(); } catch { /* Best effort before the one allowed auth retry. */ }
      accessToken = await options.refreshAccessToken();
      continue;
    }
    if (response.status === 401) await options.onUnauthorized?.();
    return readSpotifyResponse(response);
  }
  throw new Error('Spotify authorization retry limit reached. Reconnect Spotify.');
}
