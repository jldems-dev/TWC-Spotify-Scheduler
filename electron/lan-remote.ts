import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import { remotePage, remoteScript, remoteStyles } from "./lan-remote-page";
import type { remoteScheduleSummary } from "./lan-remote-dashboard";
import type { SpotifyConnectionState } from "./spotify-monitor";
import type { LanPairings } from "./lan-pairing";

const PORT = 38942;
const commandRoutes = new Map([
  ["/api/playback.play", "play"],
  ["/api/playback.pause", "pause"],
  ["/api/playback.next", "next"],
] as const);
type Command = "play" | "pause" | "next" | "volume";
type Network = { address: string; netmask: string };
type Playback = {
  available: boolean; playing: boolean; track: string | null; device: string | null; deviceActive: boolean;
  volume: number | null; supportsVolume: boolean;
};
type Dashboard = ReturnType<typeof remoteScheduleSummary> & {
  spotify: SpotifyConnectionState;
  announcement: boolean;
  advertisement: boolean;
  blocked: string | null;
  brandName?: string;
  brandLogoRevision?: string;
};
type Dependencies = {
  playback: () => Promise<unknown>;
  control: (command: Command, value?: number) => Promise<unknown>;
  blocked: () => string | null | Promise<string | null>;
  dashboard: () => Promise<Dashboard>;
  theme?: { stylesheet: string; assetDirectory: string };
  brandLogo?: () => Promise<{ bytes: Buffer; mime: string } | null>;
  pairings?: LanPairings;
};

function isPrivate(address: string) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function ipv4Number(address: string) {
  return address.split(".").reduce((value, part) => (value << 8) | Number(part), 0);
}

export function isLanPeer(peer: string, network: Network) {
  if (!isPrivate(peer) || !isPrivate(network.address) || !isIPv4(network.netmask)) return false;
  const mask = ipv4Number(network.netmask);
  return mask !== 0 && (ipv4Number(peer) & mask) === (ipv4Number(network.address) & mask);
}

export function findLanNetwork(interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()) {
  const priority = (name: string) => {
    if (/virtual|vethernet|vmware|vbox|vpn|wsl|tailscale|docker/i.test(name)) return 2;
    return /ethernet|^eth\d|^enp\d/i.test(name) ? 0 : 1;
  };
  return Object.entries(interfaces).sort(([a], [b]) => priority(a) - priority(b))
    .flatMap(([, addresses]) => addresses || [])
    .find(network => !network.internal && network.family === "IPv4" && isLanPeer(network.address, network));
}

const assets = new Map([
  ["/", ["text/html; charset=utf-8", remotePage]],
  ["/controller", ["text/html; charset=utf-8", remotePage]],
  ["/remote.css", ["text/css; charset=utf-8", remoteStyles]],
  ["/remote.js", ["text/javascript; charset=utf-8", remoteScript]],
]);
const themeAssets = new Map([
  ["/branding/twc-stafford-logo.png", "image/png"],
  ["/spotify.png", "image/png"],
  ...["Regular", "Medium", "SemiBold", "Bold"].map(weight => [`/fonts/Poppins-${weight}.ttf`, "font/ttf"] as const),
]);
const text = (value: unknown) => typeof value === "string" && value ? value.slice(0, 200) : null;
const validVolume = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
function playbackView(value: any): Playback {
  const track = text(value?.item?.name);
  const artists = Array.isArray(value?.item?.artists)
    ? value.item.artists.slice(0, 5).map((artist: any) => text(artist?.name)).filter(Boolean).join(", ")
    : "";
  const activeDevice = text(value?.activeDeviceName);
  const selectedDevice = text(value?.device?.name);
  const available = value?.device?.is_usable === true && (!activeDevice || activeDevice === selectedDevice);
  const volume = value?.device?.volume_percent;
  return {
    available,
    playing: value?.is_playing === true,
    track: track && artists ? `${track} — ${artists}` : track,
    device: activeDevice || selectedDevice,
    deviceActive: !!activeDevice,
    volume: available && validVolume(volume) ? volume : null,
    supportsVolume: available && value?.device?.supports_volume === true,
  };
}

export class LanRemote {
  private server: Server | null = null;
  private endpoint: { address: string; port: number } | null = null;
  private accessCode = "";
  private enabled = false;
  private error: string | null = null;
  private publishPlayback: ((value: unknown) => void) | undefined;

  constructor(private deps: Dependencies, private port = PORT) {}

  updatePlayback(value: unknown) {
    this.publishPlayback?.(value);
  }

  rotateAccessCode() {
    if (this.accessCode) this.accessCode = randomBytes(32).toString("base64url");
  }

  status() {
    return {
      enabled: this.enabled,
      online: !!this.server?.listening,
      address: this.endpoint?.address || findLanNetwork()?.address || null,
      url: this.endpoint ? `http://${this.endpoint.address}:${this.endpoint.port}` : null,
      accessCode: this.accessCode || null,
      error: this.error,
    };
  }

  async configure(enabled: boolean) {
    this.enabled = enabled;
    this.error = null;
    if (!enabled) return this.close();
    if (this.server?.listening) return;
    const network = findLanNetwork();
    if (!network) {
      this.error = "No private IPv4 LAN address is available.";
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const clients = new Map<string, number>();
    let total = 0;
    let windowStarted = Date.now();
    let cached: { view: Playback; expires: number } | undefined;
    let reading: Promise<Playback> | undefined;
    let revision = 0;
    let controlling = false;
    this.publishPlayback = value => {
      revision++;
      cached = { view: playbackView(value), expires: Date.now() + 8000 };
    };
    const themeFiles = new Map<string, Buffer>();
    const view = async (raw?: unknown) => {
      if (raw !== undefined) cached = { view: playbackView(raw), expires: Date.now() + 8000 };
      if (!cached || Date.now() >= cached.expires) {
        if (!reading) {
          const started = revision;
          reading = this.deps.playback().then(playbackView, () => playbackView(null)).then(result => {
            if (started === revision) cached = { view: result, expires: Date.now() + 8000 };
            return result;
          }).finally(() => { reading = undefined; });
        }
        if (!cached) {
          // Give a fresh or shared snapshot a moment without delaying the rest of the dashboard.
          await Promise.race([reading, new Promise<void>(resolve => {
            setTimeout(resolve, 400).unref();
          })]);
        }
      }
      const dashboard = await this.deps.dashboard();
      const playback = dashboard.spotify === "disconnected" || dashboard.spotify === "authentication-required"
        ? playbackView(null) : cached && Date.now() < cached.expires ? cached.view : playbackView(null);
      const { spotify, announcement, advertisement, blocked, schedulerEnabled, quiet, nextAction, timeZone, defaultPlaylist, todayPlaylists, brandName, brandLogoRevision } = dashboard;
      return {
        ...playback, spotify, announcement, advertisement, blocked, schedulerEnabled, quiet, timeZone, defaultPlaylist, todayPlaylists,
        ...(brandName ? { brandName: text(brandName) } : {}),
        ...(brandLogoRevision ? { brandLogoRevision } : {}),
        nextAction: nextAction ? { description: nextAction.description, name: nextAction.name, at: nextAction.at } : null,
      };
    };
    const reply = (res: ServerResponse, status: number, data: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      const peer = req.socket.remoteAddress || "";
      const authority = `${network.address}:${this.endpoint?.port}`;
      if (this.server !== server || !isLanPeer(peer, network) || req.headers.host !== authority ||
          (req.headers.origin && req.headers.origin !== `http://${authority}`) ||
          req.headers.forwarded || req.headers["x-forwarded-for"]) {
        return reply(res, 403, { error: "This connection is not allowed." });
      }
      if (Date.now() - windowStarted >= 60_000) { clients.clear(); total = 0; windowStarted = Date.now(); }
      if (++total > 240 || (clients.get(peer) || 0) >= 60) {
        res.setHeader("Retry-After", Math.max(1, Math.ceil((60_000 - (Date.now() - windowStarted)) / 1000)));
        return reply(res, 429, { error: "Too many requests. Try again shortly." });
      }
      clients.set(peer, (clients.get(peer) || 0) + 1);
      if (req.headers["transfer-encoding"] || (req.headers["content-length"] && req.headers["content-length"] !== "0")) {
        res.setHeader("Connection", "close");
        return reply(res, 400, { error: "Requests must have an empty body." });
      }
      const route = req.url || "";
      const asset = req.method === "GET" && assets.get(route);
      if (asset) return res.writeHead(200, { "Content-Type": asset[0] }).end(asset[1]);
      const theme = this.deps.theme;
      const mime = route === "/dashboard-theme.css" ? "text/css; charset=utf-8" : themeAssets.get(route);
      if (theme && mime && req.method === "GET") {
        try {
          let bytes = themeFiles.get(route);
          if (!bytes) {
            const file = route === "/dashboard-theme.css" ? theme.stylesheet : path.join(theme.assetDirectory, route.slice(1));
            bytes = await readFile(file);
            if (route === "/dashboard-theme.css")
              bytes = Buffer.from(bytes.toString("utf8").replaceAll("../assets/fonts/", "/fonts/"));
            themeFiles.set(route, bytes);
          }
          res.setHeader("Cache-Control", "public, max-age=300");
          return res.writeHead(200, { "Content-Type": mime }).end(bytes);
        } catch {
          return reply(res, 404, { error: "Dashboard asset unavailable." });
        }
      }
      const statusRequest = route === "/api/playback.getStatus" && req.method === "GET";
      const logoRequest = route === "/brand-logo" && req.method === "GET" && this.deps.brandLogo;
      const volumeRequest = req.method === "POST" && (route === "/api/playback.volume" || route.startsWith("/api/playback.volume?"));
      const command = volumeRequest ? "volume" : req.method === "POST" && commandRoutes.get(route as Parameters<typeof commandRoutes.get>[0]);
      const pairing = this.deps.pairings;
      const createPairing = !!pairing && req.method === "POST" && route === "/api/pairing.create";
      const revokePairing = !!pairing && req.method === "POST" && route === "/api/pairing.revoke";
      if (!statusRequest && !command && !logoRequest && !createPairing && !revokePairing)
        return reply(res, 404, { error: "Unknown remote operation." });
      const authorization = req.headers.authorization || "";
      const expected = Buffer.from(`Bearer ${this.accessCode}`, "ascii");
      const supplied = Buffer.from(authorization, "utf8");
      const accessCode = !!this.accessCode && supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const deviceToken = authorization.startsWith("Pairing ") ? authorization.slice(8) : "";
      const paired = !createPairing && !!deviceToken && !!pairing && await pairing.allows(deviceToken);
      if (this.server !== server || req.socket.destroyed) return;
      if (createPairing && accessCode) {
        const token = await pairing.issue();
        return token ? reply(res, 201, { token }) : reply(res, 409, { error: "PC 1 has reached its pairing limit." });
      }
      if (revokePairing && paired) {
        await pairing.revoke(deviceToken);
        return res.writeHead(204).end();
      }
      if ((!accessCode && !paired) || createPairing || revokePairing)
        return reply(res, 401, { error: "Enter a valid access code from PC 1 Settings." });
      if (logoRequest) {
        const logo = await logoRequest();
        if (!logo) return reply(res, 404, { error: "No custom logo is available." });
        return res.writeHead(200, { "Content-Type": logo.mime }).end(logo.bytes);
      }
      if (!command) return reply(res, 200, { status: await view() });
      const volume = volumeRequest ? Number(/^\/api\/playback\.volume\?percent=(100|[1-9]?\d)$/.exec(route)?.[1]) : undefined;
      if (volumeRequest && !validVolume(volume))
        return reply(res, 400, { error: "Spotify volume must be a whole number from 0 to 100." });
      const blocked = await this.deps.blocked();
      if (this.server !== server || req.socket.destroyed) return;
      if (paired && !await pairing.allows(deviceToken)) return reply(res, 401, { error: "Pairing is no longer valid." });
      if (this.server !== server || req.socket.destroyed) return;
      if (blocked || controlling) {
        return reply(res, 409, { error: blocked || "A playback command is in progress.", status: await view() });
      }
      controlling = true;
      revision++;
      try {
        const result = await this.deps.control(command, volume);
        return reply(res, 200, { status: await view(result === undefined ? null : result) });
      } catch {
        cached = undefined;
        const reason = await this.deps.blocked();
        if (reason) return reply(res, 409, { error: reason, status: await view() });
        return reply(res, 502, { error: "Spotify could not complete the playback command." });
      } finally {
        controlling = false;
      }
    };
    const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 2000, connectionsCheckingInterval: 1000 }, (req, res) => {
      void handle(req, res).catch(() => {
        if (!res.destroyed && !res.headersSent)
          reply(res, 502, { error: "Spotify playback is temporarily unavailable." });
      });
    });
    server.maxConnections = 32;
    server.maxRequestsPerSocket = 12;
    server.setTimeout(25000, socket => socket.destroy());
    server.on("checkContinue", (_req, res) => res.writeHead(417, { Connection: "close" }).end());
    this.server = server;
    await new Promise<void>(resolve => {
      server.once("close", resolve);
      server.on("error", () => {
        if (this.server === server) {
          this.server = null;
          this.endpoint = null;
          this.accessCode = "";
          this.publishPlayback = undefined;
          this.error = `Could not start LAN remote access on port ${this.port}.`;
        }
        resolve();
      });
      server.listen(this.port, network.address, () => {
        const bound = server.address();
        if (this.server === server && bound && typeof bound !== "string") {
          this.endpoint = { address: network.address, port: bound.port };
          this.accessCode = token;
        }
        resolve();
      });
    });
  }

  async close() {
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    this.accessCode = "";
    this.publishPlayback = undefined;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
