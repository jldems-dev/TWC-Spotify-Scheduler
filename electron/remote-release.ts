export const remoteReleaseRepository = { owner: "jldems-dev", repo: "TWC-Spotify-Scheduler" };
const remoteInstallerName = "TWC-Spotify-Client-Setup.exe";

export type RemoteInstaller = { version: string; url: string; sha256: string };

export async function findRemoteInstaller(request = fetch): Promise<RemoteInstaller | null> {
  const { owner, repo } = remoteReleaseRepository;
  const response = await request(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not check GitHub for the TWC Spotify Client installer.");
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid releases response.");

  let latest: RemoteInstaller | null = null;
  let legacy: RemoteInstaller | null = null;
  for (const release of releases) {
    const tag = typeof release?.tag_name === "string" && /^(?:client-)?v\d+\.\d+\.\d+$/.test(release.tag_name) ? release.tag_name : null;
    if (!tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) continue;
    const asset = release.assets.find((item: { name?: unknown; state?: unknown } | null) => item?.name === remoteInstallerName && item.state === "uploaded");
    const digest = typeof asset?.digest === "string" ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest) : null;
    if (!digest || !Number.isSafeInteger(asset.size) || asset.size <= 0 || typeof asset.browser_download_url !== "string") continue;

    const expected = `https://github.com/${owner}/${repo}/releases/download/${tag}/${remoteInstallerName}`;
    if (asset.browser_download_url !== expected) continue;
    const version = tag.slice(tag.indexOf("v") + 1);
    const independent = tag.startsWith("client-");
    const previous = independent ? latest : legacy;
    if (!previous || version.localeCompare(previous.version, "en", { numeric: true }) > 0) {
      const selection = { version, url: asset.browser_download_url, sha256: digest[1] };
      if (independent) latest = selection;
      else legacy = selection;
    }
  }
  return latest ?? legacy;
}
