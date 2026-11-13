import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('twc', {
  load: () => ipcRenderer.invoke('data:load'), save: (data: unknown) => ipcRenderer.invoke('data:save', data),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'), spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  googleConnect: () => ipcRenderer.invoke('google:connect'), googleStatus: () => ipcRenderer.invoke('google:status'), googleLocations: () => ipcRenderer.invoke('google:locations'), googleHours: (name: string) => ipcRenderer.invoke('google:hours', name), googleDisconnect: () => ipcRenderer.invoke('google:disconnect'), googleImportDesktopClient: () => ipcRenderer.invoke('google:import-desktop-client'),
  playlists: () => ipcRenderer.invoke('spotify:playlists'), spotifyPlayback: () => ipcRenderer.invoke('spotify:playback'), spotifyControl: (action: string, value?: number) => ipcRenderer.invoke('spotify:control', action, value), schedulerStatus: () => ipcRenderer.invoke('scheduler:status'),
  logsLoad: () => ipcRenderer.invoke('logs:load'), logsClear: () => ipcRenderer.invoke('logs:clear'),
  announcementsImport: () => ipcRenderer.invoke('announcements:import'), announcementsAudio: (id: string) => ipcRenderer.invoke('announcements:audio', id), announcementsDeleteFile: (id: string) => ipcRenderer.invoke('announcements:delete-file', id),
  advertisementsImport: () => ipcRenderer.invoke('advertisements:import'), advertisementsAudio: (id: string) => ipcRenderer.invoke('advertisements:audio', id), advertisementsDeleteFile: (id: string) => ipcRenderer.invoke('advertisements:delete-file', id),
  deviceInfo: () => ipcRenderer.invoke('device:info'),
  onSpotifyPlaybackStage: (listener: (stage: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { stage: string }) => listener(data.stage);
    ipcRenderer.on('spotify:playback-stage', handler);
    return () => ipcRenderer.removeListener('spotify:playback-stage', handler);
  },
  openSpotifyDesktop: () => ipcRenderer.invoke('spotify:open-desktop'),
  windowAction: (action: 'minimize'|'maximize'|'close') => ipcRenderer.invoke('window:action', action),
  log: (level: string, message: string) => ipcRenderer.invoke('log:add', { level, message })
});
