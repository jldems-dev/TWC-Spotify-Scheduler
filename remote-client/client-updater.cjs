const repository = "jldems-dev/TWC-Spotify-Scheduler";
const channel = "client";
const installer = "TWC-Spotify-Client-Setup.exe";
const releaseBase = tag => `https://github.com/${repository}/releases/download/${tag}/`;
const versionOrder = (a, b) => a.localeCompare(b, "en", { numeric: true });

async function latestClientUpdate(request) {
  const response = await request(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("GitHub release lookup failed.");
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("Invalid GitHub release response.");
  let latest;
  for (const release of releases) {
    const match = /^client-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release?.tag_name);
    if (!match || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) continue;
    const url = releaseBase(match[0]);
    const assets = [installer, `${channel}.yml`].map(name => release.assets.find(asset =>
      asset?.name === name && asset.state === "uploaded" && asset.browser_download_url === url + name &&
      Number.isSafeInteger(asset.size) && asset.size > 0));
    if (assets.some(asset => !asset)) continue;
    if (!latest || versionOrder(match[1], latest.version) > 0) latest = { url, version: match[1], size: assets[0].size };
  }
  return latest;
}

function isExpectedUpdate(info, release) {
  const file = Array.isArray(info?.files) && info.files.length === 1 ? info.files[0] : null;
  return info?.version === release.version && !info.packages &&
    file?.url === installer && file.size === release.size && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512) &&
    (info.path === undefined || info.path === installer) &&
    (info.sha512 === undefined || info.sha512 === file.sha512);
}

function createClientUpdates(updater, version, notify, request = fetch) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableDifferentialDownload = true;

  let state = { phase: "idle", version, message: "" };
  let downloadAllowed = false;
  const show = (phase, message, extra = {}) => {
    state = { ...state, phase, message, ...extra };
    notify(state);
  };
  updater.on("download-progress", ({ percent }) => {
    if (state.phase === "downloading" && Number.isFinite(percent))
      show("downloading", "Downloading update?", { progress: Math.max(0, Math.min(100, Math.round(percent))) });
  });
  updater.on("error", () => {
    if (state.phase === "installing") show("ready", "Installation could not start. Try again.");
  });

  return {
    status: () => state,
    async check() {
      if (!["idle", "current", "error"].includes(state.phase)) return;
      downloadAllowed = false;
      show("checking", "Checking for updates?");
      try {
        const release = await latestClientUpdate(request);
        if (!release || versionOrder(release.version, version) <= 0) {
          show("current", "No Client update is available.");
          return;
        }
        updater.setFeedURL({ provider: "generic", url: release.url, channel });
        const result = await updater.checkForUpdates();
        if (!result?.isUpdateAvailable || !isExpectedUpdate(result.updateInfo, release)) {
          show("error", "The Client release could not be verified. Try the update check again later.");
          return;
        }
        downloadAllowed = true;
        show("available", "Update available", { availableVersion: release.version });
      } catch {
        show("error", "Could not check for updates. Check your Internet connection and try again.");
      }
    },
    async download() {
      if (state.phase !== "available" || !downloadAllowed) return;
      show("downloading", "Downloading update?", { progress: 0 });
      try {
        const files = await updater.downloadUpdate();
        if (!files?.length) throw new Error("No verified Client installer was downloaded.");
        show("ready", "Update downloaded. Install and restart when ready.");
      } catch {
        show("available", "Download failed or could not be verified. Try again.");
      }
    },
    postpone() {
      if (state.phase === "available" || state.phase === "ready")
        show(state.phase === "ready" ? "ready-later" : "available-later", "Update postponed.");
    },
    resume() {
      if (state.phase === "available-later") show("available", "Update available");
      if (state.phase === "ready-later") show("ready", "Update downloaded. Install and restart when ready.");
    },
    install() {
      if (state.phase !== "ready") return;
      show("installing", "Installing update and restarting?");
      setImmediate(() => {
        try {
          updater.quitAndInstall(true, true);
        } catch {
          show("ready", "Installation could not start. Try again.");
        }
      });
    },
  };
}

module.exports = { channel, releaseBase, latestClientUpdate, createClientUpdates };
