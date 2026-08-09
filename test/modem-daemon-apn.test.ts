import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The modem daemon's APN apply-and-confirm machinery (manage_sim_card_info,
 * Phase 2). Sourcing the script (BASH_SOURCE guard) defines the functions
 * without opening a serial port; every AT helper is stubbed so each test can
 * assert exactly what would have reached the port.
 *
 * These are the tests that matter for the phase's headline risk: a wrong APN
 * strands a fielded device permanently, so "no cellular namespace -> no
 * CGDCONT write at all", "confirm or roll back", and "the retry cap keys on
 * the value" all get direct coverage here — far cheaper than bench iterations.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modem",
  "sim7600-lte.sh",
);

/** Source the daemon with a standard stub prelude and run one snippet. */
function sh(snippet: string): string {
  const prelude =
    `TMPD=$(mktemp -d); AT_LOG="$TMPD/at.log"; touch "$AT_LOG"; ` +
    `SETTINGS_FILE="$TMPD/settings.json"; APN_STATE_FILE="$TMPD/apn-apply.json"; ` +
    `TELEMETRY_FILE="$TMPD/telemetry.json"; REFRESH_FLAG_FILE="$TMPD/refresh.flag"; ` +
    `APN_CONFIRM_WINDOW=0; ` +
    // Nothing in a unit test may touch a serial port, the network, or sleep.
    `at_query() { echo "Q $1" >> "$AT_LOG"; case "$1" in ` +
    `"AT+CGDCONT?") printf '+CGDCONT: 1,"IP","sp.mb.com","0.0.0.0",0,0\\n+CGDCONT: 2,"IPV4V6","ims"\\nOK\\n' ;; ` +
    `*) echo OK ;; esac; }; ` +
    `at_cmd() { echo "C $1" >> "$AT_LOG"; }; ` +
    `sleep() { :; }; get_csq() { echo 20; }; write_telemetry() { :; }; ` +
    `teardown_interface() { echo "TEARDOWN" >> "$AT_LOG"; }; ` +
    `bring_up_interface() { echo "BRINGUP" >> "$AT_LOG"; return 1; }; ` +
    `apn_confirm_traffic() { return 1; }; ` +
    `is_registered() { return 0; }; LAST_REG=1; `;
  return execFileSync(
    "bash",
    ["-c", `source ${JSON.stringify(SCRIPT)}; ${prelude} ${snippet}`],
    { encoding: "utf8" },
  ).trim();
}

const dump =
  `echo "state=[$APN_STATE] applied=[$APN_APPLIED] requested=[$APN_REQUESTED] ` +
  `fails=[$APN_FAILS] err=[$APN_LAST_ERROR]"; echo "AT<$(cat "$AT_LOG")>"; ` +
  `echo "FILE<$(cat "$APN_STATE_FILE" 2>/dev/null)>"`;

function fields(out: string): Record<string, string> {
  const s = Object.fromEntries(
    [...out.matchAll(/(\w+)=\[([^\]]*)\]/g)].map((m) => [m[1], m[2]]),
  );
  s.at = /AT<([\s\S]*?)>/.exec(out)?.[1] ?? "";
  s.file = /FILE<([\s\S]*?)>/.exec(out)?.[1] ?? "";
  return s;
}

describe("pure parsers", () => {
  it("reads context 1's APN out of AT+CGDCONT?", () => {
    expect(
      sh(
        `apn_from_cgdcont '+CGDCONT: 1,"IP","sp.mb.com","0.0.0.0",0,0\n+CGDCONT: 2,"IPV4V6","ims"'`,
      ),
    ).toBe("sp.mb.com");
  });

  it("returns nothing when context 1 is not in the response", () => {
    expect(sh(`apn_from_cgdcont '+CGDCONT: 2,"IPV4V6","ims"'`)).toBe("");
    expect(sh(`apn_from_cgdcont 'OK'`)).toBe("");
  });

  it("apn_valid accepts hostname-ish values and nothing else", () => {
    expect(sh(`apn_valid "sp.mb.com" && echo yes || echo no`)).toBe("yes");
    expect(sh(`apn_valid "m2m-east.telus.iot" && echo yes || echo no`)).toBe("yes");
    // The injection cases: anything that could terminate the AT command.
    for (const evil of ['a\\";+CFUN=0', 'apn\\"', "apn x", "apn;x", "apn,x", ""]) {
      expect(sh(`apn_valid "${evil}" && echo yes || echo no`), evil).toBe("no");
    }
    expect(sh(`apn_valid "$(printf 'a%.0s' {1..101})" && echo yes || echo no`)).toBe("no");
  });
});

describe("apn_desired (settings.json read)", () => {
  it("reads absent for a missing file, missing namespace and missing key", () => {
    expect(sh(`apn_desired`)).toBe("absent");
    expect(sh(`echo '{}' > "$SETTINGS_FILE"; apn_desired`)).toBe("absent");
    expect(sh(`echo '{"cellular": {}}' > "$SETTINGS_FILE"; apn_desired`)).toBe("absent");
  });

  it("reads a valid APN", () => {
    expect(
      sh(`echo '{"cellular": {"apn": "wrong.apn"}}' > "$SETTINGS_FILE"; apn_desired`),
    ).toBe("ok wrong.apn");
  });

  it("reads the explicit empty string as empty (leave the modem alone)", () => {
    expect(sh(`echo '{"cellular": {"apn": ""}}' > "$SETTINGS_FILE"; apn_desired`)).toBe(
      "empty",
    );
  });

  it("refuses injection and mistyped values as invalid", () => {
    for (const bad of [
      '{"cellular": {"apn": "a\\";+CFUN=0"}}',
      '{"cellular": {"apn": "a b"}}',
      '{"cellular": {"apn": 5}}',
    ]) {
      expect(sh(`printf %s '${bad}' > "$SETTINGS_FILE"; apn_desired`), bad).toBe("invalid");
    }
  });

  it("treats an unreadable file as absent — never as a change", () => {
    expect(sh(`echo 'not json' > "$SETTINGS_FILE"; apn_desired`)).toBe("absent");
  });
});

describe("apn state file", () => {
  it("round-trips through save and read", () => {
    expect(
      sh(`apn_state_save applying "new.apn" "sp.mb.com" 2; apn_state_read`),
    ).toBe("applying new.apn sp.mb.com 2");
    expect(sh(`apn_state_save "done" "" "sp.mb.com" 0; apn_state_read`)).toBe(
      "done - sp.mb.com 0",
    );
  });

  it("reads a missing or garbled file as nothing-in-flight", () => {
    expect(sh(`apn_state_read`)).toBe("- - - 0");
    expect(sh(`echo garbage > "$APN_STATE_FILE"; apn_state_read`)).toBe("- - - 0");
  });

  it("drops persisted values that fail the charset check", () => {
    expect(
      sh(
        `printf '{"phase":"applying","requested":"a\\\\";x","previous":"ok.apn","fails":1}' > "$APN_STATE_FILE"; apn_state_read`,
      ),
    ).toBe("applying - ok.apn 1");
  });
});

describe("apn_maintain — the no-touch guarantees", () => {
  it("absent namespace: NO AT traffic at all", () => {
    const s = fields(sh(`APN_CHECK_AT=-9999; apn_maintain; ${dump}`));
    expect(s.at).toBe("");
    expect(s.file).toBe("");
  });

  it("empty apn: NO AT traffic at all", () => {
    const s = fields(
      sh(`echo '{"cellular": {"apn": ""}}' > "$SETTINGS_FILE"; APN_CHECK_AT=-9999; apn_maintain; ${dump}`),
    );
    expect(s.at).toBe("");
  });

  it("desired == applied: no AT traffic, verdict in-force", () => {
    const s = fields(
      sh(
        `echo '{"cellular": {"apn": "sp.mb.com"}}' > "$SETTINGS_FILE"; ` +
          `APN_APPLIED=sp.mb.com APN_STATE=in-force APN_REQUESTED=sp.mb.com APN_CHECK_AT=-9999; apn_maintain; ${dump}`,
      ),
    );
    expect(s.at).toBe("");
    expect(s.state).toBe("in-force");
  });

  it("invalid apn: rejected, and nothing reaches the port", () => {
    const s = fields(
      sh(
        `printf %s '{"cellular": {"apn": "a\\";+CFUN=0"}}' > "$SETTINGS_FILE"; ` +
          `APN_CHECK_AT=-9999; apn_maintain; ${dump}`,
      ),
    );
    expect(s.state).toBe("rejected");
    expect(s.at).toBe("");
  });

  it("defers while not registered — no fail burned, nothing written", () => {
    const s = fields(
      sh(
        `echo '{"cellular": {"apn": "new.apn"}}' > "$SETTINGS_FILE"; ` +
          `is_registered() { return 1; }; ` +
          `APN_APPLIED=sp.mb.com APN_STATE=in-force APN_CHECK_AT=-9999; apn_maintain; ${dump}`,
      ),
    );
    expect(s.at).toBe("");
    expect(s.fails).toBe("0");
  });

  it("a changed value while registered triggers the apply", () => {
    const s = fields(
      sh(
        `echo '{"cellular": {"apn": "new.apn"}}' > "$SETTINGS_FILE"; ` +
          `apn_apply() { echo "APPLY $1" >> "$AT_LOG"; }; ` +
          `APN_APPLIED=sp.mb.com APN_STATE=in-force APN_CHECK_AT=-9999; apn_maintain; ${dump}`,
      ),
    );
    expect(s.at).toContain("APPLY new.apn");
  });

  it("the retry cap keys on the VALUE: same value stops, a new value gets a fresh budget", () => {
    const capped = fields(
      sh(
        `echo '{"cellular": {"apn": "bad.apn"}}' > "$SETTINGS_FILE"; ` +
          `apn_apply() { echo "APPLY $1" >> "$AT_LOG"; }; ` +
          `APN_APPLIED=sp.mb.com APN_REQUESTED=bad.apn APN_FAILS=3 APN_STATE=rolled-back APN_CHECK_AT=-9999; ` +
          `apn_maintain; ${dump}`,
      ),
    );
    expect(capped.at).not.toContain("APPLY");
    expect(capped.state).toBe("rejected");

    const fresh = fields(
      sh(
        `echo '{"cellular": {"apn": "third.try"}}' > "$SETTINGS_FILE"; ` +
          `apn_apply() { echo "APPLY $1 fails=$APN_FAILS" >> "$AT_LOG"; }; ` +
          `APN_APPLIED=sp.mb.com APN_REQUESTED=bad.apn APN_FAILS=3 APN_STATE=rejected APN_CHECK_AT=-9999; ` +
          `apn_maintain; ${dump}`,
      ),
    );
    expect(fresh.at).toContain("APPLY third.try fails=0");
  });

  it("withdrawing the request clears a stale verdict without touching the modem", () => {
    const s = fields(
      sh(
        `echo '{}' > "$SETTINGS_FILE"; ` +
          `APN_APPLIED=sp.mb.com APN_REQUESTED=bad.apn APN_FAILS=3 APN_STATE=rejected APN_CHECK_AT=-9999; ` +
          `apn_maintain; ${dump}`,
      ),
    );
    expect(s.state).toBe("in-force");
    expect(s.requested).toBe("");
    expect(s.at).toBe("");
  });
});

describe("apn_apply — commit, confirm, rollback", () => {
  const PRIMED = `APN_APPLIED=sp.mb.com APN_STATE=in-force APN_FAILS=0`;

  it("confirm success: new APN in force, budget reset, state file done", () => {
    const s = fields(
      sh(`${PRIMED}; bring_up_interface() { echo "BRINGUP" >> "$AT_LOG"; return 0; }; apn_apply new.apn; ${dump}`),
    );
    expect(s.state).toBe("in-force");
    expect(s.applied).toBe("new.apn");
    expect(s.fails).toBe("0");
    expect(s.at).toContain('Q AT+CGDCONT=1,"IP","new.apn"');
    // The bearer bounce after the write is LOAD-BEARING: CGDCONT only binds
    // on the next activation, and without the bounce a bogus APN "confirmed"
    // over the still-attached old bearer (observed live, 2026-08-09). CGACT
    // alone cannot drop the default EPS bearer (returns ERROR, also observed
    // live), so the reliable half is the PS detach/re-attach.
    for (const step of ["Q AT+CGACT=0,1", "Q AT+CGATT=0", "Q AT+CGATT=1"]) {
      expect(s.at, step).toContain(step);
      expect(s.at.indexOf(step)).toBeGreaterThan(
        s.at.indexOf('Q AT+CGDCONT=1,"IP","new.apn"'),
      );
    }
    expect(s.at.indexOf("Q AT+CGATT=1")).toBeGreaterThan(s.at.indexOf("Q AT+CGATT=0"));
    expect(s.file).toContain('"phase": "done"');
  });

  it("confirm failure: previous APN written back, rolled-back, one failure recorded", () => {
    const s = fields(sh(`${PRIMED}; apn_apply wrong.apn; ${dump}`));
    expect(s.state).toBe("rolled-back");
    expect(s.applied).toBe("sp.mb.com");
    expect(s.requested).toBe("wrong.apn");
    expect(s.fails).toBe("1");
    expect(s.err).toContain("no data session");
    // The exact wire sequence: write new, then write previous back.
    const writes = [...s.at.matchAll(/Q AT\+CGDCONT=1,"IP","([^"]*)"/g)].map((m) => m[1]);
    expect(writes).toEqual(["wrong.apn", "sp.mb.com"]);
    // Each write is followed by a bearer bounce (detach/re-attach) so the
    // context re-attaches with the APN just written — both on the way out and
    // on the way back.
    expect([...s.at.matchAll(/Q AT\+CGATT=0/g)]).toHaveLength(2);
    expect([...s.at.matchAll(/Q AT\+CGATT=1/g)]).toHaveLength(2);
    // And a re-dial attempt after the rollback.
    expect(s.at.lastIndexOf("BRINGUP")).toBeGreaterThan(s.at.lastIndexOf("CGDCONT=1"));
  });

  it("TCP fallback rescues an ICMP-blocking carrier from a needless rollback", () => {
    const s = fields(
      sh(`${PRIMED}; apn_confirm_traffic() { echo tcp; return 0; }; apn_apply new.apn; ${dump}`),
    );
    expect(s.state).toBe("in-force");
    expect(s.applied).toBe("new.apn");
  });

  it("the state file records the way back BEFORE the modem is touched", () => {
    // Kill the apply at the first CGDCONT write: the file must already hold
    // {applying, previous} — that is what a power cut mid-apply recovers from.
    const s = fields(
      sh(
        `${PRIMED}; apn_write_cgdcont() { echo "FILE-AT-WRITE $(cat "$APN_STATE_FILE")" >> "$AT_LOG"; return 1; }; ` +
          `apn_apply wrong.apn; ${dump}`,
      ),
    );
    expect(s.at).toContain('"phase": "applying"');
    expect(s.at).toContain('"previous": "sp.mb.com"');
  });

  it("the third failure of the same value lands on rejected", () => {
    const s = fields(sh(`${PRIMED} APN_FAILS=2 APN_REQUESTED=wrong.apn; apn_apply wrong.apn; ${dump}`));
    expect(s.state).toBe("rejected");
    expect(s.fails).toBe("3");
  });

  it("a failed rollback write keeps recovery armed (phase stays applying)", () => {
    const s = fields(
      sh(
        `${PRIMED}; apn_write_cgdcont() { echo "W $1" >> "$AT_LOG"; [[ "$1" == "wrong.apn" ]]; }; ` +
          `apn_apply wrong.apn; ${dump}`,
      ),
    );
    expect(s.file).toContain('"phase": "applying"');
    expect(s.err).toContain("retrying on next modem contact");
  });
});

describe("apn_startup_recover — the way back survives restarts and resets", () => {
  it("rolls back unconditionally when a previous boot died mid-apply", () => {
    const s = fields(
      sh(
        `apn_state_save applying "wrong.apn" "sp.mb.com" 0; APN_APPLIED=""; ` +
          `apn_startup_recover; ${dump}`,
      ),
    );
    expect(s.state).toBe("rolled-back");
    expect(s.applied).toBe("sp.mb.com");
    expect(s.fails).toBe("1");
    expect(s.at).toContain('Q AT+CGDCONT=1,"IP","sp.mb.com"');
    expect(s.file).toContain('"phase": "done"');
  });

  it("adopts persisted request/fails without AT traffic when nothing was in flight", () => {
    const s = fields(
      sh(`apn_state_save "done" "bad.apn" "sp.mb.com" 3; apn_startup_recover; ${dump}`),
    );
    expect(s.requested).toBe("bad.apn");
    expect(s.fails).toBe("3");
    expect(s.at).toBe("");
  });

  it("skips the modem write when the applied APN already matches the rollback target", () => {
    const s = fields(
      sh(
        `apn_state_save applying "wrong.apn" "sp.mb.com" 1; APN_APPLIED=sp.mb.com; ` +
          `apn_startup_recover; ${dump}`,
      ),
    );
    expect(s.state).toBe("rolled-back");
    expect(s.at).not.toContain("CGDCONT=");
  });
});

describe("the reset path finishes a pending rollback even with GPS disabled", () => {
  it("gnss_recover_after_reset restores the previous APN above the ENABLE_GPS gate", () => {
    // Phase 1 shipped a bug on exactly this line for the SIM cache; the
    // rollback state has the same requirement, so it gets the same test.
    const s = fields(
      sh(
        `wait_for_modem_reboot() { return 0; }; ENABLE_GPS=0; ` +
          `apn_state_save applying "wrong.apn" "sp.mb.com" 0; ` +
          `at_query() { echo "Q $1" >> "$AT_LOG"; echo OK; }; ` + // CGDCONT? read returns bare OK
          `gnss_recover_after_reset >/dev/null 2>&1; ${dump}`,
      ),
    );
    expect(s.at).toContain('Q AT+CGDCONT=1,"IP","sp.mb.com"');
    expect(s.state).toBe("rolled-back");
  });
});

describe("telemetry cellular block", () => {
  function snapshot(assignments: string): Record<string, unknown> {
    // Re-source to restore the REAL write_telemetry the prelude stubbed out;
    // the env default keeps it writing into the test tmpdir, not /run.
    const out = sh(
      `SIM7600_TELEMETRY_FILE="$TMPD/telemetry.json"; source ${JSON.stringify(SCRIPT)}; ${assignments}; ` +
        `write_telemetry 18 connected 30 >/dev/null 2>&1; cat "$TELEMETRY_FILE"`,
    );
    return JSON.parse(out) as Record<string, unknown>;
  }

  it("is absent (null) on a daemon that has never read the APN — the no-safety-net marker", () => {
    expect(snapshot(`APN_STATE=""`).cellular).toBeNull();
  });

  it("carries the applied APN and clean state", () => {
    expect(
      snapshot(`APN_STATE=in-force APN_APPLIED=sp.mb.com APN_FAILS=0`).cellular,
    ).toMatchObject({ state: "in-force", apn_applied: "sp.mb.com", fails: 0 });
  });

  it("a rollback is fully legible: applied, requested, error and fail count", () => {
    const cell = snapshot(
      `APN_STATE=rolled-back APN_APPLIED=sp.mb.com APN_REQUESTED=wrong.apn ` +
        `APN_FAILS=2 APN_LAST_ERROR="no data session within 300s (ping and tcp both failed)" ` +
        `APN_CHANGED_AT=$(date +%s)`,
    ).cellular as Record<string, unknown>;
    expect(cell).toMatchObject({
      state: "rolled-back",
      apn_applied: "sp.mb.com",
      apn_requested: "wrong.apn",
      fails: 2,
    });
    expect(cell.last_error).toContain("no data session");
    expect(typeof cell.changed_at).toBe("string");
  });

  it("omits empty keys rather than emitting blanks", () => {
    const cell = snapshot(`APN_STATE=in-force APN_APPLIED= APN_REQUESTED=`).cellular as Record<
      string,
      unknown
    >;
    expect(cell).not.toHaveProperty("apn_applied");
    expect(cell).not.toHaveProperty("apn_requested");
    expect(cell).not.toHaveProperty("last_error");
  });
});

describe("maybe_refresh_flag (§4d)", () => {
  it("re-arms every probe throttle and deletes the flag", () => {
    const out = sh(
      `touch "$REFRESH_FLAG_FILE"; SIM_CHECK_AT=500 APN_CHECK_AT=500 LAST_BIAS_CHECK=999 SIM_ICCID=old; ` +
        `maybe_refresh_flag >/dev/null 2>&1; ` +
        `echo "sim=[$SIM_CHECK_AT] apn=[$APN_CHECK_AT] bias=[$LAST_BIAS_CHECK] iccid=[$SIM_ICCID] flag=[$([[ -f "$REFRESH_FLAG_FILE" ]] && echo yes || echo no)]"`,
    );
    const s = Object.fromEntries([...out.matchAll(/(\w+)=\[([^\]]*)\]/g)].map((m) => [m[1], m[2]]));
    expect(Number(s.sim)).toBeLessThan(0);
    expect(Number(s.apn)).toBeLessThan(0);
    expect(s.bias).toBe("0");
    expect(s.iccid).toBe("");
    expect(s.flag).toBe("no");
  });

  it("does nothing when no flag is present", () => {
    const out = sh(`SIM_CHECK_AT=500; maybe_refresh_flag; echo "sim=[$SIM_CHECK_AT]"`);
    expect(out).toContain("sim=[500]");
  });
});
