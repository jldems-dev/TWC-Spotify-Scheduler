const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, session } = require("electron");
const fs = require("node:fs/promises");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { serverOrigin, permitsDashboardRequest } = require("./server-address.cjs");
const { isPairingToken, savePairing, loadPairing, isPairingRequest } = require("./pairing-storage.cjs");

const { productName } = require("./package.json");

app.setName(productName);
// Keep the existing profile so renaming the app preserves saved pairings and the single-instance lock.
if (!app.commandLine.hasSwitch("user-data-dir")) {
  const profile = path.join(app.getPath("appData"), "TWC Spotify Remote");
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
app.setAppUserModelId("com.twcstafford.spotifyremote");
const settingsPage = path.join(__dirname, "connection.html");
const settingsURL = pathToFileURL(settingsPage).href;
const toolbarHeight = 130;
let window;
let dashboard;
let retry;
let connectDeadline;
let address = "";
let pairToken = "";
let state = "Disconnected";
let saving = false;
let updates;

ipcMain.handle("remote:update-status", event => {
  trustedSettings(event);
  return updates?.status() ?? { phase: "idle" };
});

ipcMain.handle("remote:update-action", (event, action) => {
  trustedSettings(event);
  if (action === "check") return updates?.check();
  if (action === "download") return updates?.download();
  if (action === "postpone") return updates?.postpone();
  if (action === "resume") return updates?.resume();
  if (action === "install") {
    if (saving) throw new Error("Wait for the connection settings to finish saving.");
    return updates?.install();
  }
});

function preferencesPath() {
  return path.join(app.getPath("userData"), "remote-server.json");
}

function snapshot() {
  return { address, state, paired: !!pairToken };
}

function showState(next) {
  state = next;
  if (window && !window.isDestroyed()) window.webContents.send("remote:state", snapshot());
}

function trustedSettings(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== settingsURL) throw new Error("Invalid settings request.");
}

ipcMain.handle("remote:status", event => {
  trustedSettings(event);
  return snapshot();
});

ipcMain.handle("remote:connect", async (event, value, code) => {
  trustedSettings(event);
  if (saving) return { error: "A connection is already being configured." };
  saving = true;
  try {
    let next;
    try { next = serverOrigin(value); } catch (error) { return { error: error.message }; }
    if (next === address && pairToken && !code) {
      connectDashboard(address, pairToken);
      return snapshot();
    }
    if (!isPairingToken(code)) return { error: "Enter the access code shown in PC 1 LAN Remote settings." };
    if (!await safeStorage.isAsyncEncryptionAvailable()) return { error: "Windows secure storage is unavailable." };
    const oldAddress = address;
    const oldToken = pairToken;
    let token;
    try {
      const response = await pairingRequest(next, "create", "Bearer " + code);
      if (response.status === 401) return { error: "PC 1 rejected the access code." };
      if (response.status === 404) return { error: "Update PC 1 to a scheduler version that supports persistent pairing." };
      if (response.status === 409) return { error: "PC 1 has reached its pairing limit." };
      if (response.status !== 201) return { error: "PC 1 could not issue a pairing. Try again shortly." };
      token = (await response.json()).token;
      if (!isPairingToken(token)) throw new Error("Invalid pairing");
    } catch {
      return { error: "Could not pair with PC 1. Check its address and LAN Remote status." };
    }
    try {
      await savePairing(preferencesPath(), next, token, safeStorage);
    } catch {
      revokePairing(next, token);
      return { error: "Could not save the pairing in Windows secure storage." };
    }
    revokePairing(oldAddress, oldToken);
    address = next;
    pairToken = token;
    if (window && !window.isDestroyed()) connectDashboard(next, token);
    return snapshot();
  } finally {
    saving = false;
  }
});

function pairingRequest(origin, action, authorization) {
  return fetch(origin + "/api/pairing." + action, {
    method: "POST", headers: { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(5000),
  });
}

function revokePairing(origin, token) {
  if (origin && token) void pairingRequest(origin, "revoke", "Pairing " + token).catch(() => {});
}

ipcMain.handle("remote:forget", async event => {
  trustedSettings(event);
  if (saving) return { error: "Wait for the connection to finish being configured." };
  saving = true;
  try {
    await fs.rm(preferencesPath(), { force: true });
    const previous = { address, token: pairToken };
    closeDashboard();
    address = "";
    pairToken = "";
    revokePairing(previous.address, previous.token);
    showState("Server forgotten. Enter its address and access code to pair again.");
    return snapshot();
  } catch {
    return { error: "Could not remove the saved pairing." };
  } finally {
    saving = false;
  }
});

function layoutDashboard() {
  if (!dashboard || !window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const phase = updates?.status().phase;
  const top = toolbarHeight + (phase && phase !== "idle" && phase !== "current" ? 72 : 0);
  dashboard.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

function closeDashboard() {
  clearTimeout(retry);
  clearTimeout(connectDeadline);
  if (!dashboard) return;
  const closing = dashboard;
  dashboard = undefined;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(closing);
  if (!closing.webContents.isDestroyed()) closing.webContents.close();
}

function connectDashboard(origin, token) {
  closeDashboard();
  showState("Connecting to PC 1…");
  const isolated = session.fromPartition("twc-remote-dashboard", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.removeAllListeners("will-download");
  isolated.on("will-download", event => event.preventDefault());
  isolated.webRequest.onBeforeRequest((request, respond) => respond({ cancel: !permitsDashboardRequest(origin, request) }));

  const view = new WebContentsView({
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
    },
  });
  dashboard = view;
  view.setVisible(false);
  window.contentView.addChildView(view);
  layoutDashboard();
  const contents = view.webContents;
  isolated.webRequest.onBeforeSendHeaders((request, respond) => {
    const headers = request.requestHeaders;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") delete headers[key];
    }
    if (dashboard === view && request.webContentsId === contents.id && isPairingRequest(origin, request)) {
      headers.Authorization = "Pairing " + token;
    }
    respond({ requestHeaders: headers });
  });
  isolated.webRequest.onCompleted(request => {
    if (request.statusCode !== 401 || dashboard !== view || request.webContentsId !== contents.id ||
        !isPairingRequest(origin, request) || pairToken !== token) return;
    pairToken = "";
    closeDashboard();
    showState("Pairing expired or was revoked. Enter a new access code.");
    if (!saving) {
      saving = true;
      void savePairing(preferencesPath(), origin, "", safeStorage)
        .catch(() => {})
        .finally(() => { saving = false; });
    }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    contents.on(event, details => details.preventDefault());
  }
  contents.on("render-process-gone", () => retryConnection());

  function retryConnection() {
    if (dashboard !== view || contents.isDestroyed()) return;
    clearTimeout(connectDeadline);
    view.setVisible(false);
    showState("Disconnected. Retrying in 5 seconds…");
    clearTimeout(retry);
    retry = setTimeout(() => {
      if (dashboard === view && window && !window.isDestroyed()) connectDashboard(origin, token);
    }, 5000);
  }

  connectDeadline = setTimeout(() => {
    if (dashboard !== view || contents.isDestroyed()) return;
    contents.stop();
    retryConnection();
  }, 10_000);
  void contents.loadURL(origin + "/controller").then(() => {
    if (dashboard !== view || contents.isDestroyed()) return;
    clearTimeout(connectDeadline);
    view.setVisible(true);
    showState("Dashboard loaded. See its connection indicator below.");
  }).catch(retryConnection);
}

async function start() {
  try {
    const saved = await loadPairing(preferencesPath(), safeStorage);
    address = saved.address;
    pairToken = saved.token;
    if (saved.unavailable) state = "Windows secure storage is unavailable. Saved pairing retained.";
  } catch {
    // Missing or invalid preferences leave the address field empty.
  }
  window = new BrowserWindow({
    title: productName,
    width: 1000,
    height: 820,
    minWidth: 410,
    minHeight: 500,
    backgroundColor: "#f6f8fc",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-frame-navigate", event => event.preventDefault());
  window.webContents.on("will-redirect", event => event.preventDefault());
  window.on("resize", layoutDashboard);
  window.on("close", closeDashboard);
  await window.loadFile(settingsPage);
  if (address && pairToken && window && !window.isDestroyed()) connectDashboard(address, pairToken);
  if (app.isPackaged) {
    const { autoUpdater } = require("electron-updater");
    const { createClientUpdates } = require("./client-updater.cjs");
    updates = createClientUpdates(autoUpdater, app.getVersion(), status => {
      if (window && !window.isDestroyed()) window.webContents.send("remote:update-state", status);
      layoutDashboard();
    });
    void updates.check();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(start).catch(() => app.quit());
}
