import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
/** The user's Downloads folder, or their home folder when there is none. */
export function downloads() {
  const dir = join(homedir(), "Downloads");
  return existsSync(dir) ? dir : homedir();
}
/**
 * Writes a file under `dir` without overwriting: `name.ext`, then
 * `name-2.ext` and so on. Returns the path, or null when none could be written.
 */
export function saveNew(dir: string, name: string, data: string | Uint8Array) {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= 50; n++) {
    const path = join(dir, `${base}${n > 1 ? `-${n}` : ""}${ext}`);
    try {
      writeFileSync(path, data, { flag: "wx", mode: 0o600 });
      return path;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") return null;
    }
  }
  return null;
}
