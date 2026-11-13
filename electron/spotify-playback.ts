export type PlaybackCommand = 'play' | 'pause' | 'previous' | 'next';
/** Only launch from the explicit Open Spotify action when the process is confirmed absent. */
export function shouldLaunchSpotifyDesktop(running: boolean | null): boolean { return running === false; }
export function playbackCommand(action: PlaybackCommand, deviceId?: string) {
  const verb = action === 'next' || action === 'previous' ? 'POST' : 'PUT';
  const endpoint = `/me/player/${action}`;
  return { method: verb, endpoint: deviceId ? `${endpoint}?device_id=${encodeURIComponent(deviceId)}` : endpoint };
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
