import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

const lifetime = 90 * 24 * 60 * 60 * 1000;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
type Entry = { hash: string; expires: number };

export class LanPairings {
  private writes = Promise.resolve();
  constructor(private file: () => string, private now = Date.now) {}

  private async entries(): Promise<Entry[]> {
    try {
      const value = JSON.parse(await readFile(this.file(), "utf8"));
      if (Array.isArray(value)) return value.filter(entry => typeof entry?.hash === "string"
        && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isSafeInteger(entry.expires) && entry.expires > this.now());
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return [];
  }

  private update<T>(change: (entries: Entry[]) => T): Promise<T> {
    const work = this.writes.then(async () => {
      const entries = await this.entries();
      const value = change(entries);
      const file = this.file();
      await writeFile(file + ".tmp", JSON.stringify(entries), { mode: 0o600 });
      await rename(file + ".tmp", file);
      return value;
    });
    this.writes = work.then(() => undefined, () => undefined);
    return work;
  }

  issue() {
    return this.update(entries => {
      if (entries.length >= 32) return null;
      const token = randomBytes(32).toString("base64url");
      entries.push({ hash: digest(token), expires: this.now() + lifetime });
      return token;
    });
  }

  async allows(token: string) {
    if (!validToken(token)) return false;
    const hash = digest(token);
    await this.writes;
    return (await this.entries()).some(entry => entry.hash === hash);
  }

  revoke(token: string) {
    return this.update(entries => {
      const index = entries.findIndex(entry => entry.hash === digest(token));
      if (index >= 0) entries.splice(index, 1);
    });
  }

  revokeAll() {
    return this.update(entries => { entries.length = 0; });
  }
}
