import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('twc', {
  load: () => ipcRenderer.invoke('data:load'), save: (data: unknown, replaceDefaultPlaylist = false) => ipcRenderer.invoke('data:save', data, false, replaceDefaultPlaylist), validateSettingsImport: (data: unknown) => ipcRenderer.invoke('data:save', data, true),
  setDefaultPlaylist: (playlistId: string) => ipcRenderer.invoke('spotify:set-default-playlist', playlistId),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'), spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  remoteInstaller: () => ipcRenderer.invoke('lan-remote:installer'),
  lanRemoteStatus: () => ipcRenderer.invoke('lan-remote:status'),
  revokeLanPairings: () => ipcRenderer.invoke('lan-remote:revoke-pairings'),
  reportRandomAdvertisementTimes: (entries: [string, number][]) => ipcRenderer.invoke('lan-remote:random-advertisement-times', entries),
  configureLanRemote: (enabled: boolean) => ipcRenderer.invoke('lan-remote:configure', enabled),
  onSpotifyHealth: (listener: (status: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: any) => listener(status);
    ipcRenderer.on('spotify:health', handler);
    return () => ipcRenderer.removeListener('spotify:health', handler);
  },
  googleConnect: () => ipcRenderer.invoke('google:connect'), googleStatus: () => ipcRenderer.invoke('google:status'), googleLocations: () => ipcRenderer.invoke('google:locations'), googleHours: (name: string) => ipcRenderer.invoke('google:hours', name), googleDisconnect: () => ipcRenderer.invoke('google:disconnect'), googleImportDesktopClient: () => ipcRenderer.invoke('google:import-desktop-client'),
  playlists: () => ipcRenderer.invoke('spotify:playlists'), spotifyPlayback: () => ipcRenderer.invoke('spotify:playback'), spotifyControl: (action: string, value?: number) => ipcRenderer.invoke('spotify:control', action, value), schedulerStatus: () => ipcRenderer.invoke('scheduler:status'),
  logsLoad: () => ipcRenderer.invoke('logs:load'), logsClear: () => ipcRenderer.invoke('logs:clear'),
  announcementsImport: () => ipcRenderer.invoke('announcements:import'), announcementsAudio: (id: string) => ipcRenderer.invoke('announcements:audio', id), announcementsDeleteFile: (id: string) => ipcRenderer.invoke('announcements:delete-file', id),
  announcementsStatus: () => ipcRenderer.invoke('announcements:status'),
  audioActivity: () => ipcRenderer.invoke('audio:activity'),
  setRendererAudioActivity: (kind: string, generation: number, active: boolean, resumeOnExit = false) =>
    ipcRenderer.invoke('audio:renderer-activity', kind, generation, active, resumeOnExit),
  resumeSpotifyAfterAudio: () => ipcRenderer.invoke('audio:resume-spotify'),
  onAudioActivity: (listener: (status: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: any) => listener(status);
    ipcRenderer.on('audio:activity', handler);
    return () => ipcRenderer.removeListener('audio:activity', handler);
  },
  onAnnouncementsStatus: (listener: (status: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: any) => listener(status);
    ipcRenderer.on('announcements:status', handler);
    return () => ipcRenderer.removeListener('announcements:status', handler);
  },
  advertisementsImport: () => ipcRenderer.invoke('advertisements:import'), advertisementsAudio: (id: string) => ipcRenderer.invoke('advertisements:audio', id), advertisementsDeleteFile: (id: string) => ipcRenderer.invoke('advertisements:delete-file', id),
  deviceInfo: () => ipcRenderer.invoke('device:info'),
  brandingLoad: () => ipcRenderer.invoke('branding:load'),
  brandingSave: (branding: unknown) => ipcRenderer.invoke('branding:save', branding),
  brandingUpload: (kind: 'logo'|'icon') => ipcRenderer.invoke('branding:upload', kind),
  brandingStoreIcon: (variants: unknown) => ipcRenderer.invoke('branding:store-icon', variants),
  brandingReset: () => ipcRenderer.invoke('branding:reset'),
  updaterStatus: () => ipcRenderer.invoke('updater:status'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupUpdateSettings: (patch: unknown) => ipcRenderer.invoke('backup:update-settings', patch),
  backupChooseDestination: () => ipcRenderer.invoke('backup:choose-destination'),
  backupCreate: () => ipcRenderer.invoke('backup:create'),
  backupSelectRestore: () => ipcRenderer.invoke('backup:select-restore'),
  backupRestore: (token: string) => ipcRenderer.invoke('backup:restore', token),
  onBackupStatus: (listener: (status: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: any) => listener(status);
    ipcRenderer.on('backup:status', handler);
    return () => ipcRenderer.removeListener('backup:status', handler);
  },
  onUpdaterStatus: (listener: (status: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: any) => listener(status);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
  onSpotifyPlaybackStage: (listener: (stage: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { stage: string }) => listener(data.stage);
    ipcRenderer.on('spotify:playback-stage', handler);
    return () => ipcRenderer.removeListener('spotify:playback-stage', handler);
  },
  openSpotifyDesktop: () => ipcRenderer.invoke('spotify:open-desktop'),
  windowAction: (action: 'minimize'|'maximize'|'close') => ipcRenderer.invoke('window:action', action),
  log: (level: string, message: string) => ipcRenderer.invoke('log:add', { level, message })
});
