import {
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
// Fixed metadata only. Never pass upstream exceptions, request bodies or credentials.
export function createLogger(dataDir: string) {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "app.log");
  return (
    level: "info" | "error",
    event: string,
    details: Record<string, string | number> = {},
  ) => {
    const line =
      JSON.stringify({
        level,
        event,
        ...details,
        timestamp: new Date().toISOString(),
      }) + "\n";
    try {
      if (existsSync(path) && statSync(path).size > 2_000_000)
        renameSync(path, path + ".1");
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      process.stderr.write('{"level":"error","event":"logging.failed"}\n');
    }
    process.stdout.write(line);
  };
}
