const fs = require("node:fs/promises");
const path = require("node:path");
const { serverOrigin } = require("./server-address.cjs");

const isPairingToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

async function savePairing(file, address, token, storage) {
  const saved = { address: serverOrigin(address) };
  if (token) {
    if (!isPairingToken(token) || !await storage.isAsyncEncryptionAvailable()) throw new Error("Secure pairing storage is unavailable.");
    saved.pairing = (await storage.encryptStringAsync(token)).toString("base64");
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + ".tmp", JSON.stringify(saved), { mode: 0o600 });
  await fs.rename(file + ".tmp", file);
}

async function loadPairing(file, storage) {
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  const address = serverOrigin(saved.address);
  if (typeof saved.pairing !== "string") return { address, token: "" };
  if (!await storage.isAsyncEncryptionAvailable()) return { address, token: "", unavailable: true };
  try {
    const { result, shouldReEncrypt } = await storage.decryptStringAsync(Buffer.from(saved.pairing, "base64"));
    if (!isPairingToken(result)) return { address, token: "" };
    if (shouldReEncrypt) await savePairing(file, address, result, storage).catch(() => {});
    return { address, token: result };
  } catch {
    return { address, token: "" };
  }
}

function isPairingRequest(origin, request) {
  if (request.resourceType !== "xhr") return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  if (url.origin !== origin || url.protocol !== "http:") return false;
  if (request.method === "GET") return !url.search && ["/api/playback.getStatus", "/brand-logo"].includes(url.pathname);
  return request.method === "POST" && (["/api/playback.play", "/api/playback.pause", "/api/playback.next"].includes(url.pathname)
    ? !url.search : url.pathname === "/api/playback.volume" && /^\?percent=(100|[1-9]?\d)$/.test(url.search));
}

module.exports = { isPairingToken, savePairing, loadPairing, isPairingRequest };
