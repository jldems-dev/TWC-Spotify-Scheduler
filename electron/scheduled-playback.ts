export type SpotifyPlaybackSnapshot = {
  is_playing?: boolean;
  context?: { uri?: string | null } | null;
  device?: SpotifyDevice | null;
  actions?: { disallows?: Record<string, boolean> };
};
export type SpotifyDevice = {
  id?: string | null;
  name?: string;
  type?: string;
  is_active?: boolean;
  is_restricted?: boolean;
  is_private_session?: boolean;
};
export type SpotifyDeviceStage = 'initial' | 'after-transfer';
export type SpotifyPlaybackStage = 'transfer-requested' | 'device-switching' | 'playback-starting' | 'playing' | 'paused' | 'playback-failed';

export function spotifyPlaylistUri(playlistId: string): string {
  const uri = playlistId.startsWith('spotify:playlist:') ? playlistId : `spotify:playlist:${playlistId}`;
  if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(uri)) throw new Error('This schedule has an invalid Spotify playlist ID. Refresh playlists and select a valid playlist.');
  return uri;
}

/** Safe fields for operational logs; the raw Spotify device ID is never logged. */
export function sanitizeSpotifyDevices(devices: SpotifyDevice[]) {
  return devices.map(device => ({
    device_id_present: typeof device.id === 'string' && device.id.length > 0,
    name: typeof device.name === 'string' ? device.name.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 100) : null,
    type: typeof device.type === 'string' ? device.type.slice(0, 40) : null,
    is_active: typeof device.is_active === 'boolean' ? device.is_active : null,
    is_restricted: typeof device.is_restricted === 'boolean' ? device.is_restricted : null,
    is_private_session: typeof device.is_private_session === 'boolean' ? device.is_private_session : null,
  }));
}

type StartPlaybackOptions = {
  getPlayback: () => Promise<SpotifyPlaybackSnapshot | null>;
  getDevices: () => Promise<SpotifyDevice[]>;
  transfer: (deviceId: string) => Promise<void>;
  play: (deviceId: string, playlistUri?: string) => Promise<void>;
  playlistUri?: string;
  onDevices?: (devices: SpotifyDevice[], stage: SpotifyDeviceStage) => void | Promise<void>;
  verifyStarted?: boolean;
  transitionTimeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  onStage?: (stage: SpotifyPlaybackStage) => void | Promise<void>;
};

const waitForSpotify = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const transientRead = async <T>(request: () => Promise<T>, fallback: T): Promise<T> => {
  try { return await request(); }
  catch (error) {
    // Spotify commonly returns 404 while Connect is switching players. Auth, permission,
    // and rate-limit failures are actionable and should not be hidden as a timeout.
    if (/\(404\)/.test(String(error))) return fallback;
    throw error;
  }
};

/** One bounded discovery/transfer/start flow shared by manual resume and scheduled playlist starts. */
export async function startSpotifyPlayback(options: StartPlaybackOptions): Promise<{ deviceId: string; transferred: boolean }> {
  const playlistUri = options.playlistUri ? spotifyPlaylistUri(options.playlistUri) : undefined;
  let playback = await options.getPlayback();
  let devices = await options.getDevices();
  if (!Array.isArray(devices)) throw new Error('Spotify did not return a fresh device list; playback was not started.');
  await options.onDevices?.(devices, 'initial');

  const usable = devices.filter(device => typeof device.id === 'string' && device.id.length > 0 && device.is_restricted !== true);
  if (!usable.length) {
    if (devices.length && devices.every(device => device.is_restricted === true)) throw new Error('Spotify has no controllable playback device: every available device is restricted.');
    throw new Error('Spotify returned no available controllable playback device. Make sure Spotify lists the PC in Available Devices, then try again.');
  }
  const currentId = playback?.device?.id;
  let target = usable.find(device => device.is_active === true)
    || usable.find(device => device.id === currentId)
    || usable[0];
  let transferred = false;
  const playlistAlreadyPlaying = (state: SpotifyPlaybackSnapshot | null) => !!state?.is_playing && (!playlistUri || state.context?.uri === playlistUri);
  if (playlistAlreadyPlaying(playback)) return { deviceId: target.id!, transferred };
  if (target.is_active !== true) {
    await options.onStage?.('transfer-requested');
    await options.transfer(target.id!);
    transferred = true;
    await options.onStage?.('device-switching');
    const deadline = Date.now() + (options.transitionTimeoutMs ?? 6000);
    let transferConfirmed = false;
    while (Date.now() <= deadline) {
      // Spotify may start playback before its device list reflects the transfer.
      playback = await transientRead(options.getPlayback, null);
      if (playlistAlreadyPlaying(playback)) return { deviceId: target.id!, transferred };
      devices = await transientRead(options.getDevices, []);
      if (Array.isArray(devices)) await options.onDevices?.(devices, 'after-transfer');
      const active = devices.find(device => device.id === target.id && device.is_active === true && device.is_restricted !== true);
      if (active) { target = active; transferConfirmed = true; break; }
      if (Date.now() >= deadline) break;
      await (options.wait || waitForSpotify)(options.pollIntervalMs ?? 300);
    }
    if (!transferConfirmed) throw new Error('Spotify accepted the playback transfer, but the device did not become active before the confirmation timeout.');
    // Fetch state again after activation: the previous playback response can predate the transfer.
    playback = await transientRead(options.getPlayback, null);
    if (playlistAlreadyPlaying(playback)) return { deviceId: target.id!, transferred };
  }

  const disallows = playback?.actions?.disallows || {};
  if (playlistUri && disallows.interrupting_playback) throw new Error('Spotify does not allow interrupting the current playback for this scheduled playlist.');
  if (!playlistUri && disallows.resuming) throw new Error('Spotify does not allow resuming playback on the selected device.');
  await options.onStage?.('playback-starting');
  await options.play(target.id!, playlistUri);

  if (options.verifyStarted !== false) {
    const deadline = Date.now() + (options.transitionTimeoutMs ?? 6000);
    while (Date.now() <= deadline) {
      const started = await transientRead(options.getPlayback, null);
      if (playlistAlreadyPlaying(started)) { await options.onStage?.('playing'); return { deviceId: target.id!, transferred }; }
      if (Date.now() >= deadline) break;
      await (options.wait || waitForSpotify)(options.pollIntervalMs ?? 300);
    }
    throw new Error('Spotify accepted the playback request, but playback could not be confirmed as started before the confirmation timeout.');
  }
  return { deviceId: target.id!, transferred };
}

/** Starts a schedule only with a current, controllable Spotify Connect device. */
export async function startScheduledPlayback(options: {
  playlistId: string;
  getPlayback: () => Promise<SpotifyPlaybackSnapshot | null>;
  getDevices: () => Promise<SpotifyDevice[]>;
  transfer?: (deviceId: string) => Promise<void>;
  play: (deviceId: string, playlistUri: string) => Promise<void>;
  onDevices?: (devices: SpotifyDevice[], stage: SpotifyDeviceStage) => void | Promise<void>;
  transitionTimeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  onStage?: (stage: SpotifyPlaybackStage) => void | Promise<void>;
}): Promise<{ deviceId: string; transferred: boolean }> {
  const playlistUri = spotifyPlaylistUri(options.playlistId);
  if (!options.transfer) throw new Error('Spotify playback transfer is unavailable; playback was not started.');
  return startSpotifyPlayback({
    playlistUri,
    getPlayback: options.getPlayback,
    getDevices: options.getDevices,
    transfer: options.transfer,
    play: deviceId => options.play(deviceId, playlistUri),
    onDevices: options.onDevices,
    verifyStarted: true,
    transitionTimeoutMs: options.transitionTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    wait: options.wait,
    onStage: options.onStage,
  });
}

export function missingPlaybackScopes(scope: unknown): string[] {
  const granted = typeof scope === 'string' ? new Set(scope.split(/\s+/).filter(Boolean)) : new Set<string>();
  return ['user-read-playback-state', 'user-modify-playback-state'].filter(required => !granted.has(required));
}
