import { Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const play = renderToStaticMarkup(createElement(Play, { fill: "currentColor", "aria-hidden": true }));
const pause = renderToStaticMarkup(createElement(Pause, { fill: "currentColor", "aria-hidden": true }));
const previous = renderToStaticMarkup(createElement(SkipBack, { "aria-hidden": true }));
const next = renderToStaticMarkup(createElement(SkipForward, { "aria-hidden": true }));
const volume = renderToStaticMarkup(createElement(Volume2, { size: 20, "aria-hidden": true }));
const monitor = icon('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4M8 21h8"/>');
const calendar = icon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 15h2M14 15h2"/>');
const music = icon('<path d="M9 18V5l12-2v13"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="18" cy="16" rx="3" ry="2"/>');
const list = icon('<path d="M3 6h12M3 12h12M3 18h7M20 6v12"/><circle cx="17" cy="18" r="3"/>');

export const remotePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TWC Spotify Client</title>
  <link rel="stylesheet" href="/dashboard-theme.css">
  <link rel="stylesheet" href="/remote.css">
  <script src="/remote.js" defer></script>
</head>
<body class="remote-body">
  <main class="remote-content">
    <header class="welcome remote-welcome">
      <div class="remote-brand">
        <img id="brand-logo" class="brand-image" src="/branding/twc-stafford-logo.png" alt="TWC Stafford">
        <h1 id="brand-name" hidden>TWC Stafford</h1>
        <p>TWC Spotify Client</p>
      </div>
      <div class="connection remote-connection" id="connection-card">
        <i class="remote-connection-dot" aria-hidden="true"></i>
        <div><b id="connection" role="status">Disconnected</b><span>LAN remote</span></div>
        <img class="spotify-mark" src="/spotify.png" alt="" width="40" height="40">
      </div>
    </header>
    <form id="pair" class="panel remote-pair">
      <label for="code">Access code from PC 1 Settings</label>
      <input id="code" type="password" autocomplete="off" required maxlength="43">
      <button class="primary" type="submit">Connect</button>
    </form>
    <div id="player" hidden>
      <div id="dashboard" hidden>
        <div class="status-card">
          <section aria-labelledby="current-heading" class="status-unit">
            <h2 id="current-heading">Current Status</h2>
            <div class="status-line"><div class="round-icon">${play}</div><div>
              <b id="playback"></b>
              <span id="track"></span>
              <span id="spotify"></span>
              <span id="scheduler"></span>
              <span id="announcement" hidden>Announcement Playing</span>
              <span id="advertisement" hidden>Advertisement Playing</span>
            </div></div>
          </section>
          <section aria-labelledby="device-heading" class="status-unit">
            <h2 id="device-heading">Playback Device</h2>
            <div class="status-line"><div class="square-icon">${monitor}</div><div>
              <b id="device"></b>
              <span id="device-status"></span>
            </div></div>
          </section>
          <section aria-labelledby="schedule-heading" class="status-unit">
            <h2 id="schedule-heading">Next Schedule Action</h2>
            <div class="status-line"><div class="square-icon blue-icon">${calendar}</div><div>
              <b id="schedule-action"></b>
              <span id="schedule-time"></span>
            </div></div>
          </section>
        </div>
        <section class="playback-controls remote-playback" aria-label="Spotify playback controls">
          <div class="playback-buttons">
            <button type="button" id="remote-previous" class="icon-btn" aria-label="Previous track (unavailable on remote)" title="Previous track is unavailable in TWC Spotify Client" disabled>${previous}</button>
            <button type="button" id="remote-play-toggle" class="play-toggle" aria-label="Play" title="Play" aria-describedby="playback-lock" disabled>
              <span id="remote-play-icon">${play}</span>
              <span id="remote-pause-icon" hidden>${pause}</span>
            </button>
            <button type="button" id="remote-next" class="icon-btn" aria-label="Next track" title="Next track" aria-describedby="playback-lock" disabled>${next}</button>
          </div>
          <div class="volume-control">
            ${volume}
            <input id="spotify-volume" aria-label="Spotify volume" aria-describedby="playback-lock" type="range" min="0" max="100" value="0" disabled>
            <b id="spotify-volume-value">-%</b>
          </div>
          <p class="playback-note" id="playback-lock" role="status" hidden></p>
        </section>
        <div class="playlist-row">
          <section aria-labelledby="default-heading" class="info-card">
            <div class="square-icon">${music}</div>
            <div><h2 id="default-heading">Default Playlist</h2><b id="default-playlist"></b></div>
          </section>
          <section aria-labelledby="today-heading" class="info-card">
            <div class="square-icon">${list}</div>
            <div><h2 id="today-heading">Today's Playlist</h2><b id="today-playlist"></b></div>
          </section>
        </div>
      </div>
      <button type="button" class="outline subtle remote-disconnect" id="disconnect">Disconnect</button>
    </div>
    <p class="remote-message" id="message" role="status"></p>
  </main>
</body>
</html>`;

export const remoteStyles = `
.remote-body { height: auto; min-height: 100vh; overflow: auto; background: radial-gradient(ellipse at 53% 3%, #fff, #fbfcfe 50%, #f6f8fc); }
.remote-body [hidden] { display: none !important; }
.remote-content { max-width: 1260px; margin-inline: auto; padding: clamp(16px, 4vw, 40px); }
.remote-welcome { min-height: 0; align-items: center; margin-bottom: clamp(18px, 4vw, 32px); }
.remote-brand, .remote-brand h1 { min-width: 0; overflow-wrap: anywhere; }
.remote-brand .brand-image { width: min(100%, 180px); max-height: 60px; margin-bottom: 8px; }
.remote-brand h1 { font-size: clamp(27px, 4.5vw, 44px); }
.remote-brand p { font-size: clamp(16px, 2vw, 20px); color: #52647f; }
.remote-connection { margin-top: 0; min-height: 72px; }
.remote-connection > div span { color: #52647f; }
.remote-connection-dot { flex: 0 0 12px; height: 12px; border-radius: 50%; background: #dc4c4c; }
.remote-connection[data-online="true"] .remote-connection-dot { background: #22a06b; }
.remote-pair { display: grid; gap: 10px; max-width: 420px; }
.remote-pair label { font-size: 14px; font-weight: 600; }
.remote-pair input { width: 100%; min-width: 0; min-height: 44px; padding: 8px 12px; border: 1px solid #8190a8; border-radius: 9px; background: #fff; }
.remote-pair button, .remote-disconnect { justify-self: start; min-height: 44px; }
.status-unit h2, .info-card h2 { margin: 0; color: #52647f; font-size: 12px; font-weight: 600; letter-spacing: .55px; text-transform: uppercase; overflow-wrap: anywhere; }
.status-line > .round-icon, .status-line > .square-icon { flex: 0 0 auto; }
.status-line div span { color: #52647f; font-size: 13px; }
.remote-playback { grid-template-columns: auto minmax(220px, 1fr); }
.remote-playback .icon-btn:disabled:hover { color: #7789a4; background: transparent; }
.remote-playback .playback-note { margin: 0; color: #9c3c2a; overflow-wrap: anywhere; }
.remote-disconnect { margin-top: 18px; }
.remote-content :focus-visible { outline: 3px solid #251d51; outline-offset: 3px; }
#announcement, #advertisement { color: #9c3c2a; font-weight: 600; }
.remote-message { color: #9c3c2a; overflow-wrap: anywhere; font-size: 14px; }
.remote-message:empty { display: none; }
@media (max-width: 700px) {
  .remote-welcome { align-items: stretch; }
  .remote-playback { padding: 12px; grid-template-columns: minmax(0, 1fr); }
}
`;

export const remoteScript = `
const element = id => document.getElementById(id);
const playToggle = element("remote-play-toggle");
const nextTrack = element("remote-next");
const slider = element("spotify-volume");
const desktop = globalThis.location?.pathname === "/controller";
let code = "";
let status = null;
let online = false;
let busy = false;
let commandBusy = false;
let volumeDraft = null;
let pendingVolume = null;
let generation = 0;
let logoRevision = "";
let logoUrl = "";

function updateLogo() {
  const revision = status?.brandLogoRevision || "";
  if (revision === logoRevision) return;
  logoRevision = revision;
  if (logoUrl) URL.revokeObjectURL(logoUrl);
  logoUrl = "";
  element("brand-logo").src = "/branding/twc-stafford-logo.png";
  element("brand-logo").alt = "TWC Stafford";
  if (!revision) return;
  const version = generation;
  void fetch("/brand-logo", {
    headers: desktop ? {} : { Authorization: "Bearer " + code },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  }).then(async response => {
    if (!response.ok) return;
    const image = await response.blob();
    if (version !== generation || logoRevision !== revision) return;
    logoUrl = URL.createObjectURL(image);
    element("brand-logo").src = logoUrl;
    element("brand-logo").alt = status.brandName || "TWC Stafford";
  }).catch(() => {});
}

function draw() {
  element("pair").hidden = desktop || !!code;
  element("player").hidden = !desktop && !code;
  element("disconnect").hidden = desktop;
  element("dashboard").hidden = !online || !status;
  element("connection").textContent = online ? "Online" : "Disconnected";
  element("connection-card").dataset.online = String(online);
  element("brand-name").textContent = status?.brandName || "TWC Stafford";
  element("brand-name").hidden = !status;
  updateLogo();
  element("track").textContent = status?.track || "No track information";
  element("device").textContent = status?.device || "No Spotify device available";
  element("device-status").textContent = status?.deviceActive
    ? (status.available ? "Active" : "Active. Controls unavailable.")
    : status?.available ? "Available, inactive" : "Unavailable";
  element("playback").textContent = status?.playing ? "Playing"
    : status?.deviceActive ? "Paused" : status?.available ? "Ready" : "Playback unavailable";
  element("spotify").textContent = ({
    connected: "Spotify connected",
    disconnected: "Spotify disconnected",
    reconnecting: "Spotify reconnecting",
    "authentication-required": "Spotify connection needs authorization",
    "no-playback-device": "Spotify connected. No controllable device.",
    "playback-error": "Spotify connection temporarily unavailable",
  })[status?.spotify] || "";
  element("scheduler").textContent = status?.quiet ? "Quiet Hours active" : status?.schedulerEnabled ? "Scheduler enabled" : "Spotify scheduler disabled";
  element("announcement").hidden = !status?.announcement;
  element("advertisement").hidden = !status?.advertisement;
  const next = status?.nextAction;
  element("schedule-action").textContent = next
    ? [next.description, next.name].filter(Boolean).join(" · ") : "No upcoming scheduled action";
  element("schedule-time").textContent = next
    ? new Date(next.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: status.timeZone }) + " (" + status.timeZone + ")" : "";
  element("default-playlist").textContent = status?.defaultPlaylist || "No default playlist configured";
  element("today-playlist").textContent = status?.todayPlaylists?.join(", ") || "No playlist scheduled today";
  const lock = element("playback-lock");
  lock.hidden = !status?.blocked;
  lock.textContent = status?.blocked || "";
  slider.disabled = commandBusy || !status?.supportsVolume || !!status.blocked;
  if (slider.disabled) volumeDraft = null;
  slider.value = String(volumeDraft ?? status?.volume ?? 0);
  element("spotify-volume-value").textContent = (status?.volume ?? "-") + "%";
  const playing = status?.playing === true;
  const toggleLabel = playing ? "Pause" : "Play";
  playToggle.setAttribute("aria-label", toggleLabel);
  playToggle.title = toggleLabel;
  element("remote-play-icon").hidden = playing;
  element("remote-pause-icon").hidden = !playing;
  playToggle.disabled = busy || !status?.available || !!status.blocked;
  nextTrack.disabled = playToggle.disabled || !playing;
}

async function request(action, volume) {
  if ((!desktop && !code) || busy) return;
  const version = generation;
  busy = true;
  commandBusy = action !== "getStatus";
  draw();
  try {
    const response = await fetch("/api/playback." + action + (action === "volume" ? "?percent=" + volume : ""), {
      method: action === "getStatus" ? "GET" : "POST",
      headers: desktop ? {} : { Authorization: "Bearer " + code },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (version !== generation) return;
    if (response.status === 401) {
      code = "";
      status = null;
      online = false;
    } else if (response.ok || response.status === 409) {
      status = data.status;
      online = true;
    } else if (response.status === 502) {
      status = null;
      online = true;
    } else if (action === "getStatus") {
      status = null;
    }
    element("message").textContent = data.error === status?.blocked ? "" : data.error || "";
  } catch {
    if (version !== generation) return;
    status = null;
    online = false;
    element("message").textContent = "Connection to PC 1 is unavailable. Retrying.";
  } finally {
    if (version === generation) {
      busy = false;
      commandBusy = false;
      draw();
      const queuedVolume = pendingVolume;
      pendingVolume = null;
      if (queuedVolume !== null && !slider.disabled && queuedVolume !== status?.volume)
        void request("volume", queuedVolume);
    }
  }
}

element("pair").addEventListener("submit", event => {
  event.preventDefault();
  code = element("code").value.trim();
  element("code").value = "";
  void request("getStatus");
});
element("disconnect").addEventListener("click", () => {
  generation++;
  code = "";
  status = null;
  online = false;
  busy = false;
  commandBusy = false;
  pendingVolume = null;
  volumeDraft = null;
  element("message").textContent = "";
  draw();
});
playToggle.addEventListener("click", () => void request(status?.playing ? "pause" : "play"));
nextTrack.addEventListener("click", () => void request("next"));
slider.addEventListener("input", () => { volumeDraft = Number(slider.value); });
function commitVolume() {
  if (volumeDraft === null || slider.disabled) return;
  const value = volumeDraft;
  volumeDraft = null;
  if (value === status?.volume) return;
  if (busy) pendingVolume = value;
  else void request("volume", value);
}
slider.addEventListener("pointerup", commitVolume);
slider.addEventListener("keyup", commitVolume);
for (const event of ["pointercancel", "blur"]) {
  slider.addEventListener(event, () => { volumeDraft = null; draw(); });
}
setInterval(() => void request("getStatus"), 5000);
draw();
if (desktop) void request("getStatus");
`;

