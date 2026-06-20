/** Small pure formatting helpers shared across screens. */

/** SIM7600 CSQ (0–31, or 99 = unknown) → RSSI in dBm, per the modem datasheet. */
export function csqToDbm(csq: number): number | null {
  if (csq === 99 || csq < 0 || csq > 31) return null;
  return -113 + csq * 2;
}

/** Human label for a CSQ value, matching the connection-manager thresholds. */
export function csqQuality(csq: number): string {
  if (csq === 99) return "unknown";
  if (csq <= 9) return "too weak";
  if (csq <= 14) return "marginal";
  return "good";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Seconds → m:ss for elapsed timers. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

/** Hex address like 0x4a for display. */
export function toHexAddr(addr: number): string {
  return `0x${addr.toString(16).padStart(2, "0")}`;
}

/** Fixed-decimal with an explicit sign, e.g. +0.853 / -0.04 — for sensor readouts. */
export function signedFixed(n: number, dp: number): string {
  const v = n.toFixed(dp);
  return v.startsWith("-") ? v : `+${v}`;
}

/** Timestamp slug safe for filenames, derived from an ISO string. */
export function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-").replace(/[^0-9A-Za-z-]/g, "");
}

/** Compact uptime from a duration in ms: "12s" / "4m 12s" / "3h 2m" / "2d 5h". */
export function uptimeLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** "just now" / "0.9s ago" / "5m ago" for a past epoch-ms timestamp. */
export function ageLabel(tsMs: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - tsMs);
  if (ms < 1000) return "just now";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s ago`;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
