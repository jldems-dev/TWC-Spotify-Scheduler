const path = require("node:path");
const { version: electronVersion } = require("electron/package.json");
const { productName, version } = require("./package.json");
const { channel, releaseBase } = require("./client-updater.cjs");

module.exports = {
  appId: "com.twcstafford.spotifyremote",
  productName,
  electronVersion,
  ...(process.platform === "win32" && process.arch === "x64"
    ? { electronDist: path.resolve(__dirname, "../node_modules/electron/dist") }
    : {}),
  directories: { app: "remote-client", output: "release-remote" },
  files: ["main.cjs", "server-address.cjs", "pairing-storage.cjs", "preload.cjs", "connection.html", "connection.css", "connection.js", "client-updater.cjs", "package.json"],
  npmRebuild: false,
  publish: {
    provider: "generic",
    channel,
    url: releaseBase(`client-v${version}`),
  },
  win: {
    target: "nsis",
    icon: "assets/icons/app-icon-release.ico",
    artifactName: `${productName} Setup.exe`,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: productName,
    installerIcon: "assets/icons/app-icon-release.ico",
    uninstallerIcon: "assets/icons/app-icon-release.ico",
    differentialPackage: false,
    runAfterFinish: false,
  },
};
