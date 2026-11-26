import { classifySpotifyHealth } from './spotify-monitor';

export type PlaybackCommand = 'play' | 'pause' | 'previous' | 'next';

export function isSpotifyConnectionError(error: unknown): boolean {
  const { state } = classifySpotifyHealth({ authenticated: true, error });
  return state === 'authentication-required' || state === 'reconnecting' ||
    /Connect Spotify|\(5\d\d\)/i.test(String(error));
}

/** Only launch from the explicit Open Spotify action when the process is confirmed absent. */
export function shouldLaunchSpotifyDesktop(running: boolean | null): boolean { return running === false; }
export function playbackCommand(action: PlaybackCommand, deviceId?: string) {
  const verb = action === 'next' || action === 'previous' ? 'POST' : 'PUT';
  const endpoint = `/me/player/${action}`;
  return { method: verb, endpoint: deviceId ? `${endpoint}?device_id=${encodeURIComponent(deviceId)}` : endpoint };
}

export async function pauseSpotifyPlayback(
  deviceId: string,
  options: {
    pause: (deviceId: string) => Promise<unknown>;
    getPlayback: (signal: AbortSignal) => Promise<any>;
    getDevices: (signal: AbortSignal) => Promise<any[]>;
    onAccepted: () => void;
    timeoutMs?: number;
    intervalMs?: number;
  },
) {
  try {
    await options.pause(deviceId);
  } catch (error) {
    if (isSpotifyConnectionError(error)) throw new Error(`Spotify connection lost while sending Pause. ${String(error)}`);
    if (/\(404\)/.test(String(error))) throw new Error('The selected Spotify playback device is unavailable.');
    throw new Error(`Spotify rejected Pause. ${String(error)}`);
  }
  options.onAccepted();

  const timeoutMs = options.timeoutMs ?? 8_000;
  const intervalMs = options.intervalMs ?? 750;
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  let state: any;
  let readError: unknown;
  while (performance.now() < deadline && !signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - performance.now()))));
    if (performance.now() >= deadline || signal.aborted) break;
    try {
      state = await options.getPlayback(signal);
      readError = undefined;
      if (!signal.aborted && state?.device?.id === deviceId && state.is_playing === false) return state;
    } catch (error) {
      readError = error;
      if (!isSpotifyConnectionError(error) || classifySpotifyHealth({ authenticated: true, error }).state === 'authentication-required') break;
    }
  }

  if (readError && isSpotifyConnectionError(readError))
    throw new Error(`Spotify accepted Pause, but the Spotify connection was lost during verification. ${String(readError)}`);
  if (readError) throw new Error(`Spotify accepted Pause, but playback state could not be checked. ${String(readError)}`);
  if (state?.device?.id === deviceId && state.is_playing === true)
    throw new Error('Spotify accepted Pause, but playback was still active on the selected device after verification timed out.');

  // Spotify reports only the current player, so check availability once if the target disappeared.
  const devices = await options.getDevices(AbortSignal.timeout(2_000)).catch(error => {
    const reason = isSpotifyConnectionError(error) ? 'the Spotify connection was lost' : 'device availability could not be checked';
    throw new Error(`Spotify accepted Pause, but ${reason} during verification. ${String(error)}`);
  });
  if (!devices.some(device => device?.id === deviceId && !device.is_restricted))
    throw new Error('Spotify accepted Pause, but the selected playback device became unavailable.');
  if (state?.device?.id && state.device.id !== deviceId)
    throw new Error('Spotify accepted Pause, but playback moved to another device before Pause could be confirmed.');
  throw new Error('Spotify accepted Pause, but the selected device did not report a paused state before verification timed out.');
}

export function transferPlaybackCommand(deviceId: string) {
  return { method: 'PUT', endpoint: '/me/player', body: { device_ids: [deviceId], play: false } };
}

export function playlistPlaybackCommand(playlistUri: string, deviceId: string) {
  if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(playlistUri)) throw new Error('Invalid Spotify playlist URI.');
  return { method: 'PUT', endpoint: `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, body: { context_uri: playlistUri } };
}

export function activeDeviceId(playback: any, devices: any[] = []): string | null {
  if (playback?.device?.is_active && !playback.device.is_restricted && typeof playback.device.id === 'string') return playback.device.id;
  const active = devices.find(device => device?.is_active && !device.is_restricted && typeof device.id === 'string');
  return active?.id || null;
}

/** Prefer the current active player, then any available Connect device Spotify can control. */
export function usableDevice(playback: any, devices: any[] = []): any | null {
  const candidates = [playback?.device, ...devices].filter(device => device && typeof device.id === 'string' && device.id && !device.is_restricted);
  return candidates.find(device => device.is_active) || candidates[0] || null;
}

export function usableDeviceId(playback: any, devices: any[] = []): string | null {
  return usableDevice(playback, devices)?.id || null;
}

/** Display the active player even if Spotify does not allow commands on it. */
export function activePlaybackDeviceName(playback: any, devices: any[]): string | null {
  const player = playback?.device;
  const active = player && (player.is_active || playback.is_playing)
    ? player
    : devices.find(device => device?.is_active);
  return active?.name || null;
}
