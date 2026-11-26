const { isIPv4 } = require("node:net");

function serverOrigin(value) {
  const match = typeof value === "string" && /^(?:http:\/\/)?([\d.]+)(?::(\d{1,5}))?\/?$/i.exec(value.trim());
  if (!match || !isIPv4(match[1])) throw new Error("Enter PC 1’s private IPv4 address, with a port if needed.");
  const [first, second] = match[1].split(".").map(Number);
  if (!(first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)))
    throw new Error("PC 1 must have a private IPv4 address on the local network.");
  const port = match[2] === undefined ? 38942 : Number(match[2]);
  if (port < 1 || port > 65535) throw new Error("Enter a port from 1 to 65535.");
  return new URL(`http://${match[1]}:${port}`).origin;
}

function permitsDashboardRequest(origin, request) {
  try {
    const url = new URL(request.url);
    return url.origin === origin && (
      (url.protocol === "http:" && request.resourceType !== "subFrame") ||
      (url.protocol === "blob:" && request.resourceType === "image")
    );
  } catch {
    return false;
  }
}

module.exports = { serverOrigin, permitsDashboardRequest };
