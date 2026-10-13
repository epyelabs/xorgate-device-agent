import { describe, expect, it } from "vitest";
import { formatScanTable, parseObdArgs } from "../src/commands/obd.js";
import { profileSummary } from "../src/agent/collectors/obd.js";

describe("xorgate obd <args> (P3)", () => {
  it("parses scan/status/help and the --seconds bounds", () => {
    expect(parseObdArgs([])).toEqual({ cmd: "help" });
    expect(parseObdArgs(["--help"])).toEqual({ cmd: "help" });
    expect(parseObdArgs(["status"])).toEqual({ cmd: "status" });
    expect(parseObdArgs(["scan"])).toEqual({ cmd: "scan", seconds: 25, json: false });
    expect(parseObdArgs(["scan", "--json", "--seconds", "10"])).toEqual({ cmd: "scan", seconds: 10, json: true });
    expect(parseObdArgs(["scan", "--seconds=120"])).toEqual({ cmd: "scan", seconds: 120, json: false });
    expect(parseObdArgs(["scan", "--seconds", "0"])).toMatchObject({ cmd: "error" });
    expect(parseObdArgs(["scan", "--seconds", "x"])).toMatchObject({ cmd: "error" });
    expect(parseObdArgs(["pair", "10:21:3E:4F:33:65"])).toMatchObject({ cmd: "error" }); // there is no pair subcommand, by design
  });

  it("formats the table (rssi null as a dash) and an empty hint", () => {
    const table = formatScanTable([
      { mac: "10:21:3E:4F:33:65", name: "OBDII", rssi: -58 },
      { mac: "00:1D:A5:68:98:8B", name: "V-LINK", rssi: null },
    ]);
    expect(table.split("\n")[0]).toBe("MAC                RSSI   NAME");
    expect(table).toContain("10:21:3E:4F:33:65   -58   OBDII");
    expect(table).toContain("00:1D:A5:68:98:8B     —   V-LINK");
    expect(table).toContain("never pairs by name");
    expect(formatScanTable([])).toContain("no named Bluetooth devices found");
  });

  it("profileSummary is one line, or null before a probe", () => {
    expect(profileSummary(null)).toBeNull();
    expect(
      profileSummary({
        protocol: { dpn: "A6", dp: "AUTO, ISO 15765-4 (CAN 11/500)" },
        responders: ["7E8", "7E9"],
        supported_fields: ["rpm", "speed"],
        unsupported_fields: ["fuel_rate"],
        powertrain: "ice",
        adapter: { ati: "ELM327 v1.5" },
      }),
    ).toBe("AUTO, ISO 15765-4 (CAN 11/500) · ECUs 7E8,7E9 · 2/3 fields · ice · ELM327 v1.5");
  });
});
