import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The modem daemon's SIM parsers (manage_sim_card_info_in_settings, Phase 1).
 *
 * `modem/sim7600-lte.sh` guards its `main` call with a BASH_SOURCE check, so
 * sourcing it here defines the functions without opening /dev/ttyUSB2 or
 * starting a connection manager. Every function under test is pure: it takes
 * an AT response as a string and prints a value.
 *
 * These matter because the daemon interpolates the results straight into
 * telemetry JSON, and because misreading "+CME ERROR: SIM not inserted" as
 * anything other than "no SIM" is the exact failure that cost a day on
 * 2026-08-08. Every response form below was observed on the bench (README §8)
 * or is the 27.007 CME code for a SIM fault.
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

describe("sim_state_from_cpin", () => {
  it("reads a healthy SIM as ready", () => {
    expect(call("sim_state_from_cpin", lines("+CPIN: READY", "OK"))).toBe("ready");
  });

  it("reads every 'no SIM' form as not-detected", () => {
    // The 2026-08-08 case. This must never be mistaken for "no signal".
    expect(call("sim_state_from_cpin", "+CME ERROR: SIM not inserted")).toBe("not-detected");
    expect(call("sim_state_from_cpin", "+CME ERROR: 10")).toBe("not-detected");
  });

  it("does not confuse a longer CME code with code 10", () => {
    expect(call("sim_state_from_cpin", "+CME ERROR: 100")).toBe("unknown");
  });

  it("reads PIN/PUK as locked", () => {
    expect(call("sim_state_from_cpin", lines("+CPIN: SIM PIN", "OK"))).toBe("locked");
    expect(call("sim_state_from_cpin", lines("+CPIN: SIM PUK", "OK"))).toBe("locked");
    expect(call("sim_state_from_cpin", "+CME ERROR: 11")).toBe("locked");
    expect(call("sim_state_from_cpin", "+CME ERROR: 12")).toBe("locked");
  });

  it("treats an unclassified +CPIN state as locked, not as absent", () => {
    // A card IS in the slot; we just cannot use it. Sending someone to check
    // the socket would be the wrong instruction.
    expect(call("sim_state_from_cpin", lines("+CPIN: PH-NET PIN", "OK"))).toBe("locked");
  });

  it("distinguishes a SIM fault from a missing SIM", () => {
    expect(call("sim_state_from_cpin", "+CME ERROR: 13")).toBe("error");
    expect(call("sim_state_from_cpin", "+CME ERROR: 15")).toBe("error");
  });

  it("says unknown for a response it cannot classify", () => {
    expect(call("sim_state_from_cpin", "ERROR")).toBe("unknown");
    expect(call("sim_state_from_cpin", "+CME ERROR: unknown")).toBe("unknown");
    expect(call("sim_state_from_cpin", "")).toBe("unknown");
  });
});

describe("sim_iccid_from_ciccid", () => {
  it("reads the card serial", () => {
    expect(call("sim_iccid_from_ciccid", lines("+ICCID: 8912230000507537488", "OK"))).toBe(
      "8912230000507537488",
    );
  });

  it("accepts the +CCID spelling some firmware uses", () => {
    expect(call("sim_iccid_from_ciccid", lines("+CCID: 8912230000507537488", "OK"))).toBe(
      "8912230000507537488",
    );
  });

  it("returns nothing when the SIM is absent", () => {
    expect(call("sim_iccid_from_ciccid", "+CME ERROR: SIM not inserted")).toBe("");
    expect(call("sim_iccid_from_ciccid", "ERROR")).toBe("");
  });
});

describe("sim_msisdn_from_cnum", () => {
  it("reads the number out of the second field", () => {
    expect(call("sim_msisdn_from_cnum", lines('+CNUM: "","+14379073824",145', "OK"))).toBe(
      "+14379073824",
    );
  });

  it("tolerates an alpha tag on the first field", () => {
    expect(
      call("sim_msisdn_from_cnum", lines('+CNUM: "Line 1","+14379073824",145', "OK")),
    ).toBe("+14379073824");
  });

  it("returns nothing when the carrier never wrote EF_MSISDN", () => {
    // The common case, and NOT a fault — the key is omitted rather than blank.
    expect(call("sim_msisdn_from_cnum", lines("OK"))).toBe("");
    expect(call("sim_msisdn_from_cnum", "ERROR")).toBe("");
  });
});

describe("sim_carrier_from_cops", () => {
  it("reads the operator name", () => {
    expect(call("sim_carrier_from_cops", lines('+COPS: 0,0,"Public Mobile",7', "OK"))).toBe(
      "Public Mobile",
    );
  });

  it("returns nothing when the modem is not registered", () => {
    expect(call("sim_carrier_from_cops", lines("+COPS: 0", "OK"))).toBe("");
    expect(call("sim_carrier_from_cops", "ERROR")).toBe("");
  });

  it("strips quotes and backslashes out of network-supplied text", () => {
    // The name is interpolated straight into telemetry JSON; one unbalanced
    // quote would take out every reader of that file.
    expect(call("sim_carrier_from_cops", '+COPS: 0,0,"Ac\\me",7')).toBe("Acme");
  });

  it("caps a preposterously long operator name", () => {
    const long = "A".repeat(80);
    expect(call("sim_carrier_from_cops", `+COPS: 0,0,"${long}",7`)).toHaveLength(32);
  });
});

describe("sim_act_from_cops / sim_act_label", () => {
  it("labels the access technology", () => {
    expect(call("sim_act_from_cops", '+COPS: 0,0,"Public Mobile",7')).toBe("7");
    expect(call("sim_act_label", "7")).toBe("lte");
    expect(call("sim_act_label", "2")).toBe("3g");
    expect(call("sim_act_label", "0")).toBe("2g");
    expect(call("sim_act_label", "11")).toBe("5g");
  });

  it("says nothing for an access technology it does not know", () => {
    expect(call("sim_act_label", "42")).toBe("");
    expect(call("sim_act_label", "")).toBe("");
  });
});

describe("sim_registration_label", () => {
  it("maps every 3GPP <stat> the daemon can see", () => {
    expect(call("sim_registration_label", "1")).toBe("home");
    expect(call("sim_registration_label", "5")).toBe("roaming");
    expect(call("sim_registration_label", "2")).toBe("searching");
    // The network REJECTED this SIM — an unpaid or deprovisioned account, which
    // is a different problem from "searching" and nothing else tells them apart.
    expect(call("sim_registration_label", "3")).toBe("denied");
    expect(call("sim_registration_label", "0")).toBe("not-searching");
    expect(call("sim_registration_label", "99")).toBe("unknown");
    expect(call("sim_registration_label", "4")).toBe("unknown");
  });
});

describe("telemetry JSON", () => {
  /** Render one write_telemetry snapshot with the SIM globals forced. */
  function snapshot(assignments: string): Record<string, unknown> {
    const out = sh(
      `TELEMETRY_FILE=$(mktemp -d)/telemetry.json; ${assignments}; ` +
        `write_telemetry 18 connected 30 >/dev/null 2>&1; cat "$TELEMETRY_FILE"`,
    );
    return JSON.parse(out) as Record<string, unknown>;
  }

  it("omits the sim block entirely before the first probe", () => {
    // An absent block means "this daemon has nothing to say" — the same thing a
    // daemon predating this plan says. It must never read as "no SIM".
    expect(snapshot("SIM_CHECKED_AT=0").sim).toBeNull();
  });

  it("carries a full SIM identity once probed", () => {
    const t = snapshot(
      `SIM_CHECKED_AT=$(date +%s) SIM_STATE=ready SIM_ICCID=8912230000507537488 ` +
        `SIM_MSISDN=+14379073824 SIM_CARRIER="Public Mobile" SIM_ACT=lte LAST_REG=1`,
    );
    expect(t.sim).toMatchObject({
      present: 1,
      state: "ready",
      iccid: "8912230000507537488",
      msisdn: "+14379073824",
      carrier: "Public Mobile",
      act: "lte",
      registration: "home",
    });
    expect(typeof (t.sim as Record<string, unknown>).checked_at).toBe("string");
  });

  it("reports an absent SIM confidently", () => {
    const sim = snapshot(
      `SIM_CHECKED_AT=$(date +%s) SIM_STATE=not-detected LAST_REG=0`,
    ).sim as Record<string, unknown>;
    expect(sim.present).toBe(0);
    expect(sim.state).toBe("not-detected");
    // No identity to report, and no blank keys pretending otherwise.
    expect(sim).not.toHaveProperty("iccid");
    expect(sim).not.toHaveProperty("msisdn");
    expect(sim).not.toHaveProperty("carrier");
  });

  it("omits msisdn rather than emitting an empty string", () => {
    const sim = snapshot(
      `SIM_CHECKED_AT=$(date +%s) SIM_STATE=ready SIM_ICCID=8912230000507537488 ` +
        `SIM_MSISDN= SIM_CARRIER="Public Mobile" LAST_REG=1`,
    ).sim as Record<string, unknown>;
    expect(sim).toHaveProperty("iccid");
    expect(sim).not.toHaveProperty("msisdn");
  });

  it("reports present as null when the SIM state is unknown", () => {
    const sim = snapshot(`SIM_CHECKED_AT=$(date +%s) SIM_STATE=unknown`).sim as Record<
      string,
      unknown
    >;
    expect(sim.present).toBeNull();
    expect(sim.state).toBe("unknown");
  });

  it("always carries an uplink block", () => {
    const uplink = snapshot("SIM_CHECKED_AT=0").uplink as Record<string, unknown>;
    expect(uplink).toHaveProperty("primary");
    expect([0, 1]).toContain(uplink.modem_only);
  });
});
