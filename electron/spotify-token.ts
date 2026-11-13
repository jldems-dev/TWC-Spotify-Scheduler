export function parseSecureToken(decrypted: string): any {
  let token: any;
  try { token = JSON.parse(decrypted); }
  catch { throw new Error('Stored Spotify credentials are not valid token JSON. The credential file was left untouched; reconnect Spotify to replace it.'); }
  if (!token || typeof token !== 'object' || Array.isArray(token) || typeof token.access_token !== 'string') throw new Error('Stored Spotify credentials have an invalid format. The credential file was left untouched; reconnect Spotify to replace it.');
  return token;
}
