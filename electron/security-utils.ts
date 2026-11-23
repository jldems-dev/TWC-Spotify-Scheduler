/** Redact credential-shaped values before text reaches logs, diagnostics, or renderer errors. */
export function redactSecrets(value: unknown): string {
  return String(value)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|refresh_token|client_secret|authorization_code|code_verifier|code|api[_-]?key|password|license[_-]?key|secret)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:access_token|refresh_token|client_secret|authorization_code|oauth_code|code_verifier|code|api[_-]?key|password|license[_-]?key|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}&]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{20,})\b/g, "[REDACTED]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"'<>]+/gi, "$1[USER]")
    .replace(/(\/(?:Users|home)\/)[^/\s"'<>]+/g, "$1[USER]");
}

export function isApprovedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && ["developer.spotify.com", "support.spotify.com"].includes(url.hostname);
  } catch { return false; }
}

export function isTrustedIpcRequest(input: { senderIsApplicationWindow: boolean; senderIsTopFrame: boolean; urlIsTrusted: boolean }): boolean {
  return input.senderIsApplicationWindow && input.senderIsTopFrame && input.urlIsTrusted;
}
