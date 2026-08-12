import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The modem daemon's USB-composition parser (ensure_usb_composition).
 *
 * The stack assumes RNDIS mode (USB PID 9011); a factory-fresh SIM7600 ships
 * at 9001 (QMI/RMNET), where usb0 can never enumerate and every dial fails
 * with "Interface usb0 never appeared" (hardware-verified 2026-08-12 on the
 * first never-onboarded SIM7600G). Misparsing the query response either way
 * is expensive: reading 9001 as 9011 leaves the modem undialable forever,
 * and reading a healthy 9011 as anything else fires a needless NV write +
 * modem re-enumeration on every daemon start.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modem",
  "sim7600-lte.sh",
);

/** Source the daemon and run one shell snippet against it. */
function sh(snippet: string): string {
  return execFileSync("bash", ["-c", `source ${JSON.stringify(SCRIPT)}; ${snippet}`], {
    encoding: "utf8",
  }).trim();
}

/** Call a daemon function with one argument, shell-quoted. */
function call(fn: string, arg: string): string {
  return sh(`${fn} ${JSON.stringify(arg)}`);
}

/** AT responses arrive as multiple lines terminated by a result code. */
const lines = (...parts: string[]): string => parts.join("\n");

describe("usb_pid_from_cusbpidswitch", () => {
  it("reads the factory QMI composition", () => {
    expect(call("usb_pid_from_cusbpidswitch", lines("+CUSBPIDSWITCH: 9001", "OK"))).toBe("9001");
  });

  it("reads the fleet RNDIS composition", () => {
    expect(call("usb_pid_from_cusbpidswitch", lines("+CUSBPIDSWITCH: 9011", "OK"))).toBe("9011");
  });

  it("tolerates the echoed command and stray whitespace", () => {
    expect(
      call(
        "usb_pid_from_cusbpidswitch",
        lines("AT+CUSBPIDSWITCH?", "+CUSBPIDSWITCH:  9011", "", "OK"),
      ),
    ).toBe("9011");
  });

  it("prints nothing for an ERROR or empty response", () => {
    expect(call("usb_pid_from_cusbpidswitch", "ERROR")).toBe("");
    expect(call("usb_pid_from_cusbpidswitch", "")).toBe("");
  });

  it("prints nothing when only unrelated URCs arrived", () => {
    expect(call("usb_pid_from_cusbpidswitch", lines("+CGEV: EPS PDN ACT 1", "OK"))).toBe("");
  });
});
