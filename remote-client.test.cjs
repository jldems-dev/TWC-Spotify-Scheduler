const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { runInNewContext } = require("node:vm");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { serverOrigin, permitsDashboardRequest } = require("./remote-client/server-address.cjs");
const config = require("./remote-client/builder.cjs");
const { savePairing, loadPairing, isPairingRequest } = require("./remote-client/pairing-storage.cjs");
const desktop = require("./package.json").build;
const clientPackage = require("./remote-client/package.json");
const { createClientUpdates, releaseBase } = require("./remote-client/client-updater.cjs");

describe("TWC Spotify Client for Windows", () => {
  it("normalizes private PC 1 addresses and ports for saved connections", () => {
    assert.equal(serverOrigin("192.168.1.20"), "http://192.168.1.20:38942");
    assert.equal(serverOrigin(" http://10.1.2.3:34567/ "), "http://10.1.2.3:34567");
    assert.equal(serverOrigin("172.31.2.4:80"), "http://172.31.2.4");
  });

  it("rejects public and ambiguous addresses, credentials, paths, and malformed ports", () => {
    for (const value of [
      null, "spotify.com", "8.8.8.8", "172.32.2.4", "127.0.0.1", "localhost", "[::1]",
      "192.168.001.2", "192.168.1.2:65536", "192.168.1.2:0", "https://192.168.1.2",
      "http://secret@192.168.1.2", "192.168.1.2/api", "192.168.1.2?code=test", "192.168.1.2#section",
    ]) assert.throws(() => serverOrigin(value));
  });

  it("only permits dashboard requests at the configured origin and same-origin branding images", () => {
    const origin = serverOrigin("192.168.1.20");
    const permit = (url, resourceType = "xhr") => permitsDashboardRequest(origin, { url, resourceType });
    assert.equal(permit(origin + "/", "mainFrame"), true);
    assert.equal(permit(origin + "/api/playback.getStatus"), true);
    assert.equal(permit("blob:" + origin + "/logo", "image"), true);
    assert.equal(permit("blob:" + origin + "/script", "script"), false);
    assert.equal(permit(origin + "/", "subFrame"), false);
    for (const url of [
      "file:///C:/Windows/win.ini", "https://example.com", "http://192.168.1.20:5555/",
      "http://192.168.1.200:38942/", "ws://192.168.1.20:38942/",
    ]) assert.equal(permit(url), false);
  });

  it("uses independent Client version, product and update metadata", () => {
    assert.notEqual(config.appId, desktop.appId);
    assert.notEqual(config.productName, desktop.productName);
    assert.equal(config.productName, "TWC Spotify Client");
    assert.equal(config.nsis.shortcutName, config.productName);
    assert.notEqual(config.directories.output, desktop.directories.output);
    assert.equal(config.directories.app, "remote-client");
    assert.equal(config.win.artifactName, "TWC Spotify Client Setup.exe");
    assert.equal(config.publish.provider, "generic");
    assert.equal(config.publish.channel, "client");
    assert.equal(config.publish.url, releaseBase(`client-v${clientPackage.version}`));
    assert.equal(config.extraMetadata, undefined);
    assert.equal(clientPackage.dependencies["electron-updater"], require("./package.json").dependencies["electron-updater"]);
    assert.ok(config.files.every(file => !file.includes("*") && !file.includes("dist")));
  });

  it("keeps the existing pairing profile and Windows app ID after rebranding", async t => {
    const appData = await fs.mkdtemp(path.join(os.tmpdir(), "twc-client-profile-"));
    t.after(() => fs.rm(appData, { recursive: true, force: true }));
    const profile = path.join(appData, "TWC Spotify Remote");
    const filename = require.resolve("./remote-client/main.cjs");
    const requireClient = createRequire(filename);
    const source = await fs.readFile(filename, "utf8");
    const electron = {
      app: {
        commandLine: { hasSwitch: () => false },
        getPath: key => { assert.equal(key, "appData"); return appData; },
        setPath: (key, value) => { assert.equal(key, "userData"); assert.equal(value, profile); },
        setName: value => assert.equal(value, "TWC Spotify Client"),
        setAppUserModelId: value => assert.equal(value, config.appId),
        requestSingleInstanceLock: () => false,
        quit() {},
      },
      ipcMain: { handle() {} },
    };
    runInNewContext(source, {
      __dirname: path.dirname(filename),
      require: name => name === "electron" ? electron : requireClient(name),
    });
    assert.equal((await fs.stat(profile)).isDirectory(), true);
  });

  it("offers the latest published Client installer from the scheduler release repository", async () => {
    const { findRemoteInstaller, remoteReleaseRepository } = require("./dist-electron/remote-release.js");
    const { owner, repo } = desktop.publish.find(entry => entry.provider === "github");
    assert.deepEqual(remoteReleaseRepository, { owner, repo });
    const file = "TWC-Spotify-Client-Setup.exe";
    const sha256 = "a".repeat(64);
    const release = version => ({
      tag_name: `client-v${version}`, draft: false, prerelease: false,
      assets: [{
        name: file, state: "uploaded", size: 1024, digest: `sha256:${sha256}`,
        browser_download_url: `https://github.com/${owner}/${repo}/releases/download/client-v${version}/${file}`,
      }],
    });
    const old = release("1.0.9");
    const current = release("1.0.10");
    const tampered = release("1.0.12");
    tampered.assets[0].browser_download_url = tampered.assets[0].browser_download_url.replace("github.com", "example.com");
    const incomplete = release("1.0.13");
    incomplete.assets[0].digest = null;
    const mock = async (url, options) => {
      assert.equal(url, `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`);
      assert.equal(options.redirect, "error");
      return { ok: true, json: async () => [old, tampered, incomplete, { ...release("2.0.0"), prerelease: true }, current] };
    };
    assert.deepEqual(await findRemoteInstaller(mock), {
      version: "1.0.10", url: current.assets[0].browser_download_url, sha256,
    });
    assert.equal(await findRemoteInstaller(async () => ({ ok: true, json: async () => [tampered, incomplete] })), null);
    await assert.rejects(findRemoteInstaller(async () => ({ ok: false })), /Could not check GitHub/);
  });

  it("restores the encrypted pairing from disk and retains it while secure storage is unavailable", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twc-pairing-client-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "remote-server.json");
    const address = serverOrigin("192.168.1.20");
    const token = randomBytes(32).toString("base64url");
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const storage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async value => {
        const cipher = createCipheriv("aes-256-ctr", key, iv);
        return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      },
      decryptStringAsync: async encrypted => {
        const decipher = createDecipheriv("aes-256-ctr", key, iv);
        return { result: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString() };
      },
    };
    await fs.writeFile(file, JSON.stringify({ address }));
    assert.deepEqual(await loadPairing(file, storage), { address, token: "" });
    await savePairing(file, address, token, storage);
    const persisted = await fs.readFile(file, "utf8");
    assert.equal(persisted.includes(token), false);
    const unavailable = { isAsyncEncryptionAvailable: async () => false };
    assert.deepEqual(await loadPairing(file, unavailable), { address, token: "", unavailable: true });
    assert.equal(await fs.readFile(file, "utf8"), persisted);
    assert.deepEqual(await loadPairing(file, storage), { address, token });
    await savePairing(file, address, "", storage);
    assert.deepEqual(await loadPairing(file, storage), { address, token: "" });
  });

  it("limits token injection to the configured origin and authorized playback requests", () => {
    const address = serverOrigin("192.168.1.20");
    const request = (url, method = "GET", resourceType = "xhr") => isPairingRequest(address, { url, method, resourceType });
    assert.equal(request(address + "/api/playback.getStatus"), true);
    assert.equal(request(address + "/api/playback.volume?percent=30", "POST"), true);
    assert.equal(request(address + "/brand-logo"), true);
    assert.equal(request(address + "/api/playback.previous", "POST"), false);
    assert.equal(request(address + "/api/pairing.create", "POST"), false);
    assert.equal(request(address + "/api/playback.volume?percent=101", "POST"), false);
    assert.equal(request(address + "/api/playback.getStatus", "GET", "mainFrame"), false);
    assert.equal(request("http://192.168.1.21:38942/api/playback.getStatus"), false);
  });
});
const installerAsset = "TWC-Spotify-Client-Setup.exe";
const validChecksum = Buffer.alloc(64).toString("base64");
function releaseFixture(version, tag = `client-v${version}`) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [installerAsset, "client.yml"].map(name => ({
      name, state: "uploaded", size: 100, browser_download_url: releaseBase(tag) + name,
    })),
  };
}

describe("independent Client updates", () => {
  const version = "1.0.11";
  const newer = "1.0.12";
  const release = releaseFixture(newer);
  const info = { version: newer, files: [{ url: installerAsset, size: 100, sha512: validChecksum }] };
  const officialReleases = (...releases) => async url => {
    assert.equal(url, "https://api.github.com/repos/jldems-dev/TWC-Spotify-Scheduler/releases?per_page=100");
    return { ok: true, json: async () => releases };
  };

  it("ignores Scheduler releases, incomplete Client releases and non-upgrades", async () => {
    const incomplete = releaseFixture("3.0.0");
    incomplete.assets.pop();
    const updater = new EventEmitter();
    updater.setFeedURL = () => assert.fail("No official Client upgrade should be checked");
    const flow = createClientUpdates(updater, version, () => {},
      officialReleases(releaseFixture("5.0.0", "v5.0.0"), releaseFixture(version), incomplete, { ...release, draft: true }));
    await flow.check();
    assert.equal(flow.status().phase, "current");
  });

  it("shows availability and progress, postpones, and installs only on request", async () => {
    const updater = new EventEmitter();
    const states = [];
    let installs = 0;
    updater.setFeedURL = feed => assert.deepEqual(feed, {
      provider: "generic", channel: "client", url: releaseBase(`client-v${newer}`),
    });
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: info });
    updater.downloadUpdate = async () => {
      updater.emit("download-progress", { percent: 42.3 });
      return ["verified-client-installer.exe"];
    };
    updater.quitAndInstall = (...args) => { assert.deepEqual(args, [true, true]); installs++; };
    const flow = createClientUpdates(updater, version, state => states.push(state), officialReleases(release));
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    await flow.check();
    assert.equal(flow.status().availableVersion, newer);
    flow.postpone();
    assert.equal(flow.status().phase, "available-later");
    await flow.download();
    flow.resume();
    await flow.download();
    assert.ok(states.some(state => state.phase === "downloading" && state.progress === 42));
    assert.equal(flow.status().phase, "ready");
    flow.postpone();
    flow.install();
    assert.equal(installs, 0);
    flow.resume();
    flow.install();
    assert.equal(flow.status().phase, "installing");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(installs, 1);
  });

  it("handles offline checks, off-origin metadata and corrupt downloads without installing", async () => {
    const updater = new EventEmitter();
    updater.setFeedURL = () => {};
    updater.quitAndInstall = () => assert.fail("No verified Client update");
    const offline = createClientUpdates(updater, version, () => {}, async () => { throw new Error("offline"); });
    await offline.check();
    assert.equal(offline.status().phase, "error");

    updater.checkForUpdates = async () => ({
      isUpdateAvailable: true, updateInfo: { ...info, files: [{ ...info.files[0], url: "https://example.com/setup.exe" }] },
    });
    const flow = createClientUpdates(updater, version, () => {}, officialReleases(release));
    await flow.check();
    await flow.download();
    assert.equal(flow.status().phase, "error");

    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: info });
    updater.downloadUpdate = async () => { throw new Error("SHA-512 checksum mismatch"); };
    await flow.check();
    await flow.download();
    assert.match(flow.status().message, /could not be verified/);
    flow.install();
  });
});
