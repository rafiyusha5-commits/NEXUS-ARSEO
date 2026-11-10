import { appendFile, mkdir, readdir, rename, lstat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeObservation } from "./policy.ts";

let serial: Promise<void> = Promise.resolve();
let waiting = 0;
export async function appendSafeLog(directory: string | undefined, input: unknown): Promise<boolean> {
  const event = safeObservation(input);
  if (!event || !directory || !isAbsolute(directory) || waiting >= 128) return false;
  const target = resolve(directory), publicRoot = resolve(process.cwd(), "public");
  const fromPublic = relative(publicRoot, target);
  if (!fromPublic || (!fromPublic.startsWith("..") && !isAbsolute(fromPublic))) return false;
  let written = false;
  waiting++;
  serial = serial.catch(() => {}).then(async () => {
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      if ((await lstat(target)).isSymbolicLink()) return;
      const file = join(target, `health-${process.pid}.jsonl`);
      const fileInfo = await lstat(file).catch(() => null);
      if (fileInfo?.isSymbolicLink()) return;
      const size = fileInfo?.size ?? 0;
      if (size >= 65536) {
        await unlink(file + ".2").catch(() => {});
        await rename(file + ".1", file + ".2").catch(() => {});
        await rename(file, file + ".1");
      }
      await appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 });
      // Only our exact filename vocabulary, never recursive deletion or caller-supplied paths.
      const entries: { path: string; time: number }[] = [];
      for (const name of await readdir(target)) {
        if (!/^health-\d+\.jsonl(?:\.[12])?$/.test(name)) continue;
        const path = join(target, name);
        const info = await lstat(path);
        if (info.isFile() && Date.now() - info.mtimeMs > 7 * 86400000) await unlink(path);
        else if (info.isFile()) entries.push({ path, time: info.mtimeMs });
      }
      // Bound total retention across restarts too: <=12 segments (~768 KiB).
      for (const entry of entries.sort((a,b) => b.time-a.time).slice(12)) await unlink(entry.path);
      written = true;
    } catch { /* A full/unwritable disk must not throw into business code. */ }
  }).finally(() => { waiting--; });
  await serial;
  return written;
}
