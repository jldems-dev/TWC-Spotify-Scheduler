const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("connection", {
  status: () => ipcRenderer.invoke("remote:status"),
  connect: (address, code) => ipcRenderer.invoke("remote:connect", address, code),
  forget: () => ipcRenderer.invoke("remote:forget"),
  updateStatus: () => ipcRenderer.invoke("remote:update-status"),
  updateAction: action => ipcRenderer.invoke("remote:update-action", action),
  onUpdate: listener => ipcRenderer.on("remote:update-state", (_event, state) => listener(state)),
  onStatus: listener => {
    ipcRenderer.on("remote:state", (_event, state) => listener(state));
  },
});
