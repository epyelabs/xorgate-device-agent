import { describe, expect, it } from "vitest";
import { parseGsv } from "../src/lib/nmea.js";
import { createSkyTracker, SKY_DEFAULTS, type SkyTracker } from "../src/lib/sky-state.js";

/**
 * Sentences below are VERBATIM from the test Pi's /dev/ttyUSB1 (2026-07-30,
 * at the window): the SIM7600 appends a trailing signalId to $GPGSV/$GLGSV and
 * an extra pair to $BDGSV, and blanks the C/N0 of satellites it lists but does
 * not hear — the two shapes the tracker's correctness hinges on.
 */
const GP_1 = "$GPGSV,3,1,10,05,31,077,29,15,79,067,20,20,46,052,30,21,,,21,1*56";
const GP_2 = "$GPGSV,3,2,10,10,11,274,,18,75,292,,23,41,286,,27,09,322,,1*61";
const GP_3 = "$GPGSV,3,3,10,29,21,202,,30,04,032,,1*6B";
const GL_1 = "$GLGSV,2,1,07,66,29,037,20,76,04,067,21,82,80,220,,75,06,018,,1*79";
const GL_2 = "$GLGSV,2,2,07,81,35,158,,67,75,310,,68,31,237,,1*47";

/** The same sky with every C/N0 blank — antenna covered/disconnected. */
const SILENT_1 = "$GPGSV,2,1,08,05,31,077,,15,79,067,,20,46,052,,21,,,,1";
const SILENT_2 = "$GPGSV,2,2,08,10,11,274,,18,75,292,,23,41,286,,27,09,322,,1";

function feed(t: SkyTracker, ...lines: string[]): void {
  for (const line of lines) {
    const msg = parseGsv(line);
    if (msg) t.note(msg);
  }
}

describe("parseGsv", () => {
  it("reads per-satellite C/N0 and tolerates the SIM7600's trailing fields", () => {
    const gp = parseGsv(GP_1)!;
    expect(gp).toMatchObject({ talker: "GP", msgNum: 1, numMsgs: 3, inView: 10 });
    expect(gp.satellites).toHaveLength(4); // the trailing signalId is not a satellite
    expect(gp.satellites[0]).toEqual({ prn: 5, elevation: 31, azimuth: 77, snr: 29 });
    // Elevation/azimuth may be blank while C/N0 is present (and vice versa).
    expect(gp.satellites[3]).toEqual({ prn: 21, elevation: null, azimuth: null, snr: 21 });

    // $BDGSV carries TWO trailing fields on this module — still 4 satellites.
    const bd = parseGsv("$BDGSV,2,1,08,20,65,039,24,11,31,171,,12,81,330,,19,57,254,,0,4*6C")!;
    expect(bd.talker).toBe("BD");
    expect(bd.satellites).toHaveLength(4);
    expect(bd.satellites[1].snr).toBeNull(); // listed, not heard
  });

  it("rejects non-GSV, bad checksums and malformed headers", () => {
    expect(parseGsv("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,,,,*47")).toBeNull();
    expect(parseGsv("$GPGSV,3,1,10,05,31,077,29*00")).toBeNull(); // checksum
    expect(parseGsv("$GPGSV,,,,")).toBeNull();
  });
});

describe("createSkyTracker", () => {
  /** A tracker on a fake monotonic clock the test advances explicitly. */
  function tracker() {
    let mono = 1_000;
    const t = createSkyTracker({ monoMs: () => mono });
    return { t, advance: (ms: number) => (mono += ms), now: () => mono };
  }

  it("starts unknown and stays unknown until GSV arrives", () => {
    const { t } = tracker();
    expect(t.snapshot()).toMatchObject({ state: "unknown", heard: 0, inView: 0 });
  });

  it("counts only satellites with a C/N0 as heard, and promotes to clear after the hold", () => {
    const { t, advance } = tracker();
    feed(t, GP_1, GP_2, GP_3, GL_1, GL_2);
    const first = t.snapshot();
    // 4 GPS + 2 GLONASS report a C/N0; 17 are listed in view across both.
    expect(first).toMatchObject({ heard: 6, usable: 6, inView: 17, maxSnr: 30 });
    // Not clear yet — good news still has to hold for clearHoldMs.
    expect(first.state).toBe("obstructed");

    advance(SKY_DEFAULTS.clearHoldMs);
    feed(t, GP_1, GP_2, GP_3, GL_1, GL_2);
    expect(t.snapshot().state).toBe("clear");
  });

  it("a silent sky reads obstructed first and only becomes no-rf after the sustain window", () => {
    const { t, advance } = tracker();
    feed(t, SILENT_1, SILENT_2);
    expect(t.snapshot()).toMatchObject({ state: "obstructed", heard: 0, inView: 8 });

    // One second short of the window: still not claiming it.
    advance(SKY_DEFAULTS.noRfHoldMs - 1_000);
    feed(t, SILENT_1, SILENT_2);
    expect(t.snapshot().state).toBe("obstructed");

    advance(1_000);
    feed(t, SILENT_1, SILENT_2);
    const snap = t.snapshot();
    expect(snap.state).toBe("no-rf");
    expect(snap.holdMs).toBe(0);
  });

  it("silence is never no-rf when NMEA itself stops — that is unknown (the wedge case)", () => {
    const { t, advance } = tracker();
    feed(t, GP_1, GP_2, GP_3);
    advance(SKY_DEFAULTS.clearHoldMs);
    feed(t, GP_1, GP_2, GP_3);
    expect(t.snapshot().state).toBe("clear");

    // The stream dies: no more sentences at all, however long we wait.
    advance(SKY_DEFAULTS.dataStaleMs + 1_000);
    expect(t.snapshot().state).toBe("unknown");
    advance(SKY_DEFAULTS.noRfHoldMs * 5);
    expect(t.snapshot()).toMatchObject({ state: "unknown", heard: 0, inView: 0 });
  });

  it("does not flap out of clear on a single bad cycle", () => {
    const { t, advance } = tracker();
    feed(t, GP_1, GP_2, GP_3);
    advance(SKY_DEFAULTS.clearHoldMs);
    feed(t, GP_1, GP_2, GP_3);
    expect(t.snapshot().state).toBe("clear");

    // One weak cycle (nothing heard) a few seconds long: still clear.
    advance(1_000);
    feed(t, SILENT_1, SILENT_2);
    expect(t.snapshot().state).toBe("clear");
    advance(SKY_DEFAULTS.leaveClearMs - 2_000);
    feed(t, SILENT_1, SILENT_2);
    expect(t.snapshot().state).toBe("clear");

    // Sustained, it does leave — to obstructed, not straight to no-rf.
    advance(2_000);
    feed(t, SILENT_1, SILENT_2);
    expect(t.snapshot().state).toBe("obstructed");
  });

  it("leaves no-rf quickly once anything is heard again", () => {
    const { t, advance } = tracker();
    feed(t, SILENT_1, SILENT_2);
    advance(SKY_DEFAULTS.noRfHoldMs);
    feed(t, SILENT_1, SILENT_2);
    expect(t.snapshot().state).toBe("no-rf");

    advance(1_000);
    feed(t, GP_1, GP_2, GP_3);
    expect(t.snapshot().state).toBe("no-rf"); // one cycle isn't enough

    advance(SKY_DEFAULTS.leaveNoRfMs);
    feed(t, GP_1, GP_2, GP_3);
    expect(t.snapshot().state).toBe("clear"); // held long enough for both hurdles
  });

  it("ignores a cycle joined mid-stream, then reads the next one whole", () => {
    const { t } = tracker();
    // Message 2 of 3 with no message 1 first: a half-read sky must not count.
    feed(t, GP_2, GP_3);
    expect(t.snapshot()).toMatchObject({ state: "unknown", heard: 0 });
    feed(t, GP_1, GP_2, GP_3);
    expect(t.snapshot()).toMatchObject({ heard: 4, inView: 10 });
  });

  it("weak-but-present signal is obstructed, never clear", () => {
    const { t, advance } = tracker();
    // Four satellites heard, all below the usable threshold.
    const weak = "$GPGSV,1,1,04,05,31,077,12,15,79,067,09,20,46,052,14,21,10,100,11,1";
    feed(t, weak);
    advance(SKY_DEFAULTS.clearHoldMs * 3);
    feed(t, weak);
    const snap = t.snapshot();
    expect(snap).toMatchObject({ state: "obstructed", heard: 4, usable: 0, maxSnr: 14 });
  });
});
