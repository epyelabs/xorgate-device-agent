import { describe, expect, it } from "vitest";
import {
  parseThrottled,
  parsePmicAdc,
  rail5vFrom,
  readMaxCurrentMa,
} from "../src/hardware/power.js";
import { powerReadingFromFields } from "../src/agent/collectors/index.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real dump captured on the CM5 test device (2026-07-24, idle on the 27W PSU).
const PMIC_DUMP = ` 3V7_WL_SW_A current(0)=0.09759300A
   3V3_SYS_A current(1)=0.07709848A
   1V8_SYS_A current(2)=0.12296720A
  DDR_VDD2_A current(3)=0.00585558A
  DDR_VDDQ_A current(4)=0.00000000A
   1V1_SYS_A current(5)=0.36597380A
    0V8_SW_A current(6)=0.36890160A
  VDD_CORE_A current(7)=0.95551000A
   3V3_DAC_A current(17)=0.00006105A
   3V3_ADC_A current(18)=0.00067155A
   0V8_AON_A current(16)=0.00347985A
      HDMI_A current(22)=0.01404150A
 3V7_WL_SW_V volt(8)=3.70812800V
   3V3_SYS_V volt(9)=3.30910500V
   1V8_SYS_V volt(10)=1.81684800V
  DDR_VDD2_V volt(11)=1.10695900V
  DDR_VDDQ_V volt(12)=0.60402870V
   1V1_SYS_V volt(13)=1.10109800V
    0V8_SW_V volt(14)=0.79926660V
  VDD_CORE_V volt(15)=0.86952300V
   3V3_DAC_V volt(20)=3.30860500V
   3V3_ADC_V volt(21)=3.30219400V
   0V8_AON_V volt(19)=0.80058540V
      HDMI_V volt(23)=5.10004000V
     EXT5V_V volt(24)=5.13756000V
      BATT_V volt(25)=0.00427350V
`;

describe("parseThrottled", () => {
  it("splits current and sticky nibbles", () => {
    expect(parseThrottled("throttled=0x50005\n")).toEqual({ current: 5, sticky: 5 });
  });

  it("reads a clean device as all-zero", () => {
    expect(parseThrottled("throttled=0x0\n")).toEqual({ current: 0, sticky: 0 });
  });

  it("keeps sticky-only events out of current", () => {
    // Undervoltage happened earlier this boot but is not active now.
    expect(parseThrottled("throttled=0x10000\n")).toEqual({ current: 0, sticky: 1 });
  });

  it("returns null on unexpected output", () => {
    expect(parseThrottled("error: unknown command\n")).toBeNull();
    expect(parseThrottled("")).toBeNull();
  });
});

describe("parsePmicAdc", () => {
  it("parses the full CM5 dump into paired rails", () => {
    const adc = parsePmicAdc(PMIC_DUMP)!;
    expect(adc).not.toBeNull();
    expect(adc.VDD_CORE).toEqual({ amps: 0.95551, volts: 0.869523 });
    expect(adc.EXT5V).toEqual({ volts: 5.13756 }); // no current channel exists
    expect(adc.BATT).toEqual({ volts: 0.0042735 });
    expect(Object.keys(adc)).toHaveLength(14); // 12 paired + EXT5V + BATT
  });

  it("returns null on Pi-4-style unsupported output", () => {
    expect(parsePmicAdc("error_msg: Command not registered\n")).toBeNull();
    expect(parsePmicAdc("")).toBeNull();
  });
});

describe("rail5vFrom", () => {
  it("extracts the EXT5V rail voltage from the dump", () => {
    expect(rail5vFrom(parsePmicAdc(PMIC_DUMP)!)).toBe(5.13756);
  });

  it("returns null when EXT5V is absent", () => {
    expect(rail5vFrom({})).toBeNull();
  });
});

describe("readMaxCurrentMa", () => {
  it("decodes the big-endian u32 device-tree node (00 00 13 88 = 5000)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-"));
    const file = join(dir, "max_current");
    await writeFile(file, Buffer.from([0, 0, 0x13, 0x88]));
    expect(await readMaxCurrentMa(file)).toBe(5000);
  });

  it("returns null on a short buffer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-"));
    const file = join(dir, "max_current");
    await writeFile(file, Buffer.from([0x13, 0x88]));
    expect(await readMaxCurrentMa(file)).toBeNull();
  });

  it("returns null when the node is absent", async () => {
    expect(await readMaxCurrentMa("/nonexistent/max_current")).toBeNull();
  });
});

/**
 * Load-shed sample decoding (power_management_improvements plan, Phase 1).
 * Before the thermal arm this bailed to null unless `throttled` was a number,
 * which would have made thermal shedding inert on any host without vcgencmd.
 */
describe("powerReadingFromFields", () => {
  it("decodes a healthy Pi sample", () => {
    expect(
      powerReadingFromFields({
        throttled: { value: 0 },
        rail_5v: { value: 5.127 },
        cpu_temp: { value: 57.1 },
      }),
    ).toEqual({ uv: false, railV: 5.127, tempC: 57.1, softTemp: false });
  });

  it("reads the undervoltage (0x1) and soft-temp (0x8) CAUSE bits", () => {
    expect(powerReadingFromFields({ throttled: { value: 0x1 } })).toMatchObject({
      uv: true,
      softTemp: false,
    });
    expect(powerReadingFromFields({ throttled: { value: 0x8 } })).toMatchObject({
      uv: false,
      softTemp: true,
    });
    expect(powerReadingFromFields({ throttled: { value: 0x9 } })).toMatchObject({
      uv: true,
      softTemp: true,
    });
  });

  it("ignores the CONSEQUENCE bits 0x2/0x4 and every sticky bit (Q3)", () => {
    // 0x2 freq-capped + 0x4 throttled: set by the firmware for EITHER cause, so
    // triggering on them would make the shed reason unattributable.
    expect(powerReadingFromFields({ throttled: { value: 0x6 } })).toMatchObject({
      uv: false,
      softTemp: false,
    });
    // 0xe0008 as measured on the bench: sticky bits 16-19 are history and the
    // agent only ever surfaces the CURRENT half — but assert it explicitly.
    expect(powerReadingFromFields({ throttled: { value: 0xe0000 } })).toMatchObject({
      uv: false,
      softTemp: false,
    });
  });

  it("returns a reading when only the temperature is readable (no vcgencmd)", () => {
    expect(powerReadingFromFields({ cpu_temp: { value: 81.4 } })).toEqual({
      uv: false,
      railV: null,
      tempC: 81.4,
      softTemp: false,
    });
  });

  it("returns a reading when only the throttle mask is readable (Pi 4, no PMIC ADC)", () => {
    expect(powerReadingFromFields({ throttled: { value: 0x1 } })).toEqual({
      uv: true,
      railV: null,
      tempC: null,
      softTemp: false,
    });
  });

  it("returns null with neither half readable — the feature stays inert off-Pi", () => {
    expect(powerReadingFromFields({ cpu_usage: { value: 12 } })).toBeNull();
    expect(powerReadingFromFields({})).toBeNull();
    expect(powerReadingFromFields(undefined)).toBeNull();
  });
});
