/**
 * `xorgate update [--tag <version>] [--from <bucket-url>]` — fetch the latest
 * device-agent build and install it in place, then restart the systemd service.
 *
 * Pulls `xorgate-agent-<version>.tar.gz` from the dist bucket recorded at
 * install time (DEVICE_DIST_BUCKET_URL in /etc/xorgate/agent.env), stages and
 * validates it on the same filesystem, atomically swaps /opt/xorgate, reinstalls
 * the systemd unit + the `xorgate` CLI wrapper, and restarts the agent. The CLI
 * lives in the same tarball, so this upgrades the CLI too.
 *
 * Requires root (writes /opt, /usr/local/bin, /etc/systemd, runs systemctl). The
 * agent's User= drop-in and the /etc/xorgate certs are left untouched.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";

const CONF_DIR = "/etc/xorgate";
const AGENT_ENV = join(CONF_DIR, "agent.env");
const INSTALL_PREFIX = "/opt/xorgate";
const STAGING = `${INSTALL_PREFIX}.new`;
const BACKUP = `${INSTALL_PREFIX}.old`;
const UNIT_DEST = "/etc/systemd/system/xorgate-agent.service";
const WRAPPER = "/usr/local/bin/xorgate";
const SERVICE = "xorgate-agent";

const WRAPPER_BODY = `#!/usr/bin/env bash
exec env XORGATE_HOME="\${XORGATE_HOME:-/var/lib/xorgate}" node ${INSTALL_PREFIX}/dist/cli.js "$@"
`;

// SIM7600 connection-manager assets shipped in the tarball (mirrors the
// install script). Refreshed on update so GNSS/LTE fixes reach the fleet; the
// running daemon is NOT restarted here — on a cellular-only device that would
// drop the very link this update rode in on. New script applies on next boot
// or a manual `systemctl restart sim7600-lte`.
const MODEM_ASSETS: Array<[src: string, dest: string, mode: number]> = [
  ["modem/sim7600-lte.sh", "/usr/local/bin/sim7600-lte.sh", 0o755],
  ["modem/sim7600-lte.service", "/etc/systemd/system/sim7600-lte.service", 0o644],
  ["modem/99-sim7600-lte.rules", "/etc/udev/rules.d/99-sim7600-lte.rules", 0o644],
  // usb0 must be unmanaged by NetworkManager or it races the daemon's dhclient
  // for the modem's internal DHCP lease and wedges reconnection after outages.
  ["modem/99-sim7600-unmanaged.conf", "/etc/NetworkManager/conf.d/99-sim7600-unmanaged.conf", 0o644],
];

const log = (s: string): void => console.log(`[xorgate] ${s}`);
const fail = (s: string): never => {
  console.error(`[xorgate] update failed: ${s}`);
  process.exit(1);
};

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Parse KEY=VALUE lines out of an env file (quotes/whitespace stripped). */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export async function updateCommand(argv: string[]): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    fail("run with sudo (writes /opt, /usr/local/bin, /etc/systemd): sudo xorgate update");
  }

  const env = parseEnvFile(AGENT_ENV);
  const bucketUrl = (
    flagValue(argv, "--from") ??
    process.env.DEVICE_DIST_BUCKET_URL ??
    env.DEVICE_DIST_BUCKET_URL ??
    ""
  ).replace(/\/$/, "");
  if (!bucketUrl) {
    fail(
      `no dist bucket URL — set DEVICE_DIST_BUCKET_URL in ${AGENT_ENV} or pass --from <url>`,
    );
  }
  const version =
    flagValue(argv, "--tag") ??
    process.env.DEVICE_DIST_VERSION ??
    env.DEVICE_DIST_VERSION ??
    "latest";

  const tarball = `xorgate-agent-${version}.tar.gz`;
  const url = `${bucketUrl}/${tarball}`;

  // 1. Download to a scratch dir (outside /opt so a failed download never
  //    lands half a tarball next to the install).
  const dl = mkdtempSync(join(tmpdir(), "xg-update-"));
  const tgz = join(dl, tarball);
  log(`downloading ${url}`);
  const got = await run("curl", ["-fsSL", "--retry", "3", "--retry-delay", "2", url, "-o", tgz]);
  if (got.failed) {
    rmSync(dl, { recursive: true, force: true });
    fail(`download failed (${got.stderr.trim() || got.exitCode}); check the version/tag and bucket`);
  }

  // 2. Stage + validate on the /opt filesystem so the final swap is an atomic
  //    rename (not a cross-device copy).
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  const untar = await run("tar", ["-xzf", tgz, "-C", STAGING]);
  rmSync(dl, { recursive: true, force: true });
  if (untar.failed) {
    rmSync(STAGING, { recursive: true, force: true });
    fail(`extract failed: ${untar.stderr.trim()}`);
  }
  if (
    !existsSync(join(STAGING, "dist", "worker.js")) ||
    !existsSync(join(STAGING, "systemd", "xorgate-agent.service"))
  ) {
    rmSync(STAGING, { recursive: true, force: true });
    fail("downloaded build is missing dist/worker.js or the systemd unit");
  }

  // 3. Install runtime deps into the staged tree (native modules build here).
  //    run() can't set a cwd, so cd via `sh -c` — same as install.sh does.
  log("installing node modules");
  const ci = await run(
    "sh",
    ["-c", `cd '${STAGING}' && npm ci --omit=dev --no-audit --no-fund`],
    { timeoutMs: 5 * 60_000 },
  );
  if (ci.failed) {
    rmSync(STAGING, { recursive: true, force: true });
    fail(`npm ci failed: ${ci.stderr.trim()}`);
  }

  // 4. Atomic swap: current -> .old, staged -> current. Restore on any later error.
  rmSync(BACKUP, { recursive: true, force: true });
  const hadPrev = existsSync(INSTALL_PREFIX);
  if (hadPrev) renameSync(INSTALL_PREFIX, BACKUP);
  try {
    renameSync(STAGING, INSTALL_PREFIX);

    // 5. Reinstall the systemd unit + CLI wrapper from the new build. The
    //    User= drop-in and certs are untouched.
    copyFileSync(join(INSTALL_PREFIX, "systemd", "xorgate-agent.service"), UNIT_DEST);
    chmodSync(UNIT_DEST, 0o644);
    rmSync(WRAPPER, { force: true }); // break any prior symlink before writing
    writeFileSync(WRAPPER, WRAPPER_BODY, { mode: 0o755 });
    chmodSync(WRAPPER, 0o755);

    // 5b. Refresh the SIM7600 modem assets when the build ships them AND the
    //     device has the daemon installed (skip devices without the modem).
    if (existsSync("/usr/local/bin/sim7600-lte.sh")) {
      let refreshed = 0;
      for (const [src, dest, mode] of MODEM_ASSETS) {
        const from = join(INSTALL_PREFIX, src);
        if (!existsSync(from)) continue;
        copyFileSync(from, dest);
        chmodSync(dest, mode);
        refreshed++;
      }
      if (refreshed > 0) {
        log(
          "modem assets refreshed — applies on next boot, or now with: sudo systemctl restart sim7600-lte",
        );
      }
    }
  } catch (err) {
    // Roll back to the previous build so we never leave a broken install.
    rmSync(INSTALL_PREFIX, { recursive: true, force: true });
    if (hadPrev) renameSync(BACKUP, INSTALL_PREFIX);
    fail(`install step failed, rolled back: ${(err as Error).message}`);
  }

  // 6. Reload + restart under the new build.
  await run("systemctl", ["daemon-reload"]);
  const restart = await run("systemctl", ["restart", SERVICE]);
  if (restart.failed) {
    log(`warning: 'systemctl restart ${SERVICE}' failed: ${restart.stderr.trim()}`);
    log(`the new build is installed; restart manually: sudo systemctl restart ${SERVICE}`);
  }

  rmSync(BACKUP, { recursive: true, force: true });
  log(`updated to '${version}'. check it with: xorgate status`);
}
