export type SpotifyConnectionState = "connected" | "disconnected" | "reconnecting" | "authentication-required" | "no-playback-device" | "playback-error";
export type SpotifyMonitorSnapshot = { state: SpotifyConnectionState; message: string; connected: boolean; deviceName?: string; deviceKey?: string };

/** Classifies one low-frequency main-process health check without retaining credentials. */
export function classifySpotifyHealth(input: { authenticated: boolean; devices?: any[]; error?: unknown }): SpotifyMonitorSnapshot {
  if (input.error) {
    const error = String(input.error);
    if (/authorization expired|revoked|reconnect|401/i.test(error)) return { state: "authentication-required", message: "Reconnect Spotify in Settings.", connected: false };
    if (/network|timed out|fetch failed|offline/i.test(error)) return { state: "reconnecting", message: "Spotify is temporarily unreachable. The app will check again shortly.", connected: false };
    return { state: "playback-error", message: "Spotify could not be checked. Try again shortly.", connected: false };
  }
  if (!input.authenticated) return { state: "disconnected", message: "Connect Spotify in Settings.", connected: false };
  const device = (input.devices || []).find(item => item?.is_active && !item?.is_restricted) || (input.devices || []).find(item => !item?.is_restricted);
  if (!device) return { state: "no-playback-device", message: "Open Spotify on a device and wait for it to appear in Available Devices.", connected: true };
  return { state: "connected", message: "Connected", connected: true, deviceName: typeof device.name === "string" ? device.name.slice(0, 100) : undefined, deviceKey: typeof device.id === "string" ? device.id : undefined };
}

export function spotifyRetryDelay(attempt: number, retryAfter?: string | null): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1));
}

export function shouldRecoverUnexpectedStop(input: { previouslyPlaying: boolean; currentlyPlaying: boolean; schedulerEnabled: boolean; quiet: boolean; announcementBusy: boolean; announcementWindowActive: boolean; activeMusicSchedule: boolean }): boolean {
  return input.previouslyPlaying && !input.currentlyPlaying && input.schedulerEnabled && !input.quiet && !input.announcementBusy && !input.announcementWindowActive && input.activeMusicSchedule;
}
