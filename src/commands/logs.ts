/**
 * `xorgate logs [-n N] [-f] [--clear]` — print or follow the daemon log.
 * v1 keeps an append-only log (no rotation); `--clear` truncates it.
 */
import { closeSync, fstatSync, openSync, readSync, truncateSync, watch } from "node:fs";
import { readLogTail } from "../daemon/manager.js";
import { logPath } from "../daemon/runtime.js";

export async function logsCommand(argv: string[]): Promise<void> {
  const path = logPath();
  const follow = argv.includes("-f") || argv.includes("--follow");
  const clear = argv.includes("--clear");
  const nIdx = argv.findIndex((a) => a === "-n" || a === "--lines");
  const n = nIdx !== -1 ? Number(argv[nIdx + 1]) || 200 : 200;

  if (clear) {
    try {
      truncateSync(path, 0);
      console.log(`✓ cleared ${path}`);
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  for (const line of readLogTail(n, path)) console.log(line);
  if (!follow) return;

  // Follow: re-read appended bytes on change; reset on truncation/rotation.
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    console.error(`(no log yet at ${path} — waiting…)`);
    return;
  }
  let offset = fstatSync(fd).size;
  const buf = Buffer.alloc(64 * 1024);

  const pump = (): void => {
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // truncated
    while (offset < size) {
      const want = Math.min(buf.length, size - offset);
      const read = readSync(fd, buf, 0, want, offset);
      if (read <= 0) break;
      offset += read;
      process.stdout.write(buf.subarray(0, read));
    }
  };

  const watcher = watch(path, pump);
  process.on("SIGINT", () => {
    watcher.close();
    closeSync(fd);
    process.exit(0);
  });
  await new Promise<void>(() => {}); // run until Ctrl-C
}
