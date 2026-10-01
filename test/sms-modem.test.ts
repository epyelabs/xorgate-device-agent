import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireSmsLock,
  AtSession,
  buildSmsPayload,
  clampSmsLimit,
  fixtureSmsSweep,
  parseCpmsQuery,
  resolveSmsPort,
  SmsReader,
  sweepTransport,
  type AtTransport,
} from "../src/hardware/sms-modem.js";
import type { SmsStorage } from "../src/hardware/sms-pdu.js";
import { buildDeliver, buildSubmit, scts } from "./sms-pdu-builder.js";
import { cleanup, tempHome } from "./helpers.js";

interface Slot {
  stat: number;
  length: number;
  pdu: string;
}

interface FakeOpts {
  stores?: Partial<Record<SmsStorage, { total: number; slots: Record<number, Slot> }>>;
  cmgf?: number;
  mem1?: string;
  /** Never answer anything (port held by something else / wedged). */
  silent?: boolean;
  /** Answer AT+CPMS? with this error (no SIM). */
  cpmsError?: string;
  /** Inject these unsolicited lines before every response. */
  urcs?: string[];
  /** Commands that get no answer at all (simulates a per-command timeout). */
  hang?: (cmd: string) => boolean;
  /** Called per command, e.g. to advance a fake clock. */
  onCommand?: (cmd: string) => void;
}

/** A scripted SIM7600 on the far side of an AtTransport. */
class FakeModem implements AtTransport {
  log: string[] = [];
  cmgf: number;
  mem1: string;
  closed = false;
  private cb: (line: string) => void = () => {};
  private readonly stores: NonNullable<FakeOpts["stores"]>;

  constructor(private readonly o: FakeOpts = {}) {
    this.cmgf = o.cmgf ?? 0;
    this.mem1 = o.mem1 ?? "SR";
    this.stores = o.stores ?? {};
  }

  onLine(cb: (line: string) => void): void {
    this.cb = cb;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private used(mem: string): number {
    return Object.keys(this.stores[mem as SmsStorage]?.slots ?? {}).length;
  }
  private total(mem: string): number {
    return mem === "SR" ? 0 : (this.stores[mem as SmsStorage]?.total ?? 0);
  }
  private triple(mem: string): string {
    return `"${mem}",${this.used(mem)},${this.total(mem)}`;
  }

  async write(data: string): Promise<void> {
    const cmd = data.replace(/\r$/, "");
    this.log.push(cmd);
    this.o.onCommand?.(cmd);
    if (this.o.silent || this.o.hang?.(cmd)) return;
    const out: string[] = [...(this.o.urcs ?? [])];
    let m: RegExpExecArray | null;
    if (cmd === "ATE0") out.push("ATE0", "OK");
    else if (cmd === "AT+CMGF?") out.push(`+CMGF: ${this.cmgf}`, "OK");
    else if ((m = /^AT\+CMGF=(\d)$/.exec(cmd))) {
      this.cmgf = Number(m[1]);
      out.push("OK");
    } else if (cmd === "AT+CPMS?") {
      if (this.o.cpmsError) out.push(this.o.cpmsError);
      else out.push(`+CPMS: ${this.triple(this.mem1)},${this.triple("ME")},${this.triple("ME")}`, "OK");
    } else if ((m = /^AT\+CPMS="(\w+)"$/.exec(cmd))) {
      this.mem1 = m[1]!;
      out.push(`+CPMS: ${this.used(this.mem1)},${this.total(this.mem1)},23,23,23,23`, "OK");
    } else if ((m = /^AT\+CMGRO=(\d+)$/.exec(cmd))) {
      if (this.cmgf !== 0) throw new Error("CMGRO sent in text mode");
      const slot = this.stores[this.mem1 as SmsStorage]?.slots[Number(m[1])];
      if (slot) out.push(`+CMGRO: ${slot.stat},"",${slot.length}`, slot.pdu, "OK");
      else out.push("ERROR");
    } else out.push("ERROR");
    queueMicrotask(() => {
      for (const l of out) this.cb(l);
    });
  }
}

const INTL = { kind: "international", value: "15550100001" } as const;

function slot(text: string, day: number, stat = 1, extra: Parameters<typeof buildDeliver>[0] extends infer T ? Partial<T> : never = {}): Slot {
  const { pdu, length } = buildDeliver({ from: INTL, text, scts: scts(2026, 8, day, 12, 0, 0, -16), ...extra });
  return { stat, length, pdu };
}

/** The bench shape: SM 7/40 (all unread, newest), ME full 23/23 (old). */
function benchStores(): NonNullable<FakeOpts["stores"]> {
  const sm: Record<number, Slot> = {};
  for (let i = 0; i < 7; i++) sm[i] = slot(`sm${i}`, 20 + i, 0);
  const me: Record<number, Slot> = {};
  for (let i = 0; i < 23; i++) me[i] = slot(`me${i}`, 1 + (i % 15), 1);
  return { SM: { total: 40, slots: sm }, ME: { total: 23, slots: me } };
}

describe("parseCpmsQuery", () => {
  it("reads the three storage triples", () => {
    expect(parseCpmsQuery('+CPMS: "SR",0,0,"ME",23,23,"ME",23,23')).toEqual([
      { mem: "SR", used: 0, total: 0 },
      { mem: "ME", used: 23, total: 23 },
      { mem: "ME", used: 23, total: 23 },
    ]);
  });
});

describe("AtSession", () => {
  it("drops URCs and echoes, keeps only lines for the command in flight", async () => {
    const fake = new FakeModem({ urcs: ['+CMTI: "SM",3', "+SMS FULL", "RDY", "SMS DONE"] });
    const at = new AtSession(fake, 200);
    const r = await at.command("AT+CMGF?", "+CMGF:");
    expect(r).toEqual({ ok: true, final: "OK", lines: ["+CMGF: 0"] });
  });

  it("times out a command nobody answers", async () => {
    const at = new AtSession(new FakeModem({ silent: true }), 30);
    await expect(at.command("ATE0")).rejects.toThrow(/timeout/);
  });
});

describe("sweepTransport", () => {
  it("reads both stores, newest first, and leaves the modem as it found it", async () => {
    const fake = new FakeModem({ stores: benchStores(), cmgf: 0, mem1: "SR" });
    const r = await sweepTransport(fake);
    expect(r.partial).toBe(false);
    expect(r.skipped).toBe(0);
    expect(r.storage).toEqual({ SM: { used: 7, total: 40 }, ME: { used: 23, total: 23 } });
    expect(r.messages).toHaveLength(30);
    expect(r.messages[0]!.text).toBe("sm6");
    expect(r.messages.slice(0, 7).every((m) => m.unread)).toBe(true);
    expect(fake.mem1).toBe("SR");
    expect(fake.cmgf).toBe(0);
    // Read-only by construction.
    expect(fake.log.some((c) => /CMGR=|CMGL|CMGD|CMGW|CMSS|CPMS="[^"]*",/.test(c))).toBe(false);
    expect(fake.log.at(-1)).toBe('AT+CPMS="SR"');
  });

  it("stops scanning a store once `used` messages are found", async () => {
    const fake = new FakeModem({
      stores: { SM: { total: 40, slots: { 0: slot("a", 1), 2: slot("b", 2) } }, ME: { total: 23, slots: {} } },
    });
    await sweepTransport(fake);
    const reads = fake.log.filter((c) => c.startsWith("AT+CMGRO="));
    expect(reads).toEqual(["AT+CMGRO=0", "AT+CMGRO=1", "AT+CMGRO=2"]);
    // ME is empty: never selected.
    expect(fake.log).not.toContain('AT+CPMS="ME"');
  });

  it("switches to PDU mode only when needed and restores text mode", async () => {
    const fake = new FakeModem({ stores: { SM: { total: 5, slots: { 1: slot("x", 3) } } }, cmgf: 1, mem1: "ME" });
    const r = await sweepTransport(fake);
    expect(r.messages.map((m) => m.text)).toEqual(["x"]);
    expect(fake.log).toContain("AT+CMGF=0");
    expect(fake.cmgf).toBe(1);
    expect(fake.mem1).toBe("ME");
  });

  it("counts stored SUBMIT PDUs as skipped", async () => {
    const s = buildSubmit();
    const fake = new FakeModem({
      stores: { SM: { total: 5, slots: { 0: slot("x", 3), 1: { stat: 3, length: s.length, pdu: s.pdu } } } },
    });
    const r = await sweepTransport(fake);
    expect(r.skipped).toBe(1);
    expect(r.messages).toHaveLength(1);
  });

  it("returns partial when the budget runs out, and still restores", async () => {
    let t = 0;
    const fake = new FakeModem({ stores: benchStores(), onCommand: () => (t += 1000) });
    const r = await sweepTransport(fake, { budgetMs: 10_000, now: () => t });
    expect(r.partial).toBe(true);
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.messages.length).toBeLessThan(30);
    expect(fake.mem1).toBe("SR");
  });

  it("returns partial when a CMGRO hangs", async () => {
    const fake = new FakeModem({ stores: benchStores(), hang: (c) => c === "AT+CMGRO=3" });
    const r = await sweepTransport(fake, { commandTimeoutMs: 30 });
    expect(r.partial).toBe(true);
    expect(r.messages).toHaveLength(3);
  });

  it("maps a silent port to modem_busy and a SIM error to no_sim", async () => {
    await expect(sweepTransport(new FakeModem({ silent: true }), { commandTimeoutMs: 30 })).rejects.toMatchObject({
      status: "modem_busy",
    });
    await expect(sweepTransport(new FakeModem({ cpmsError: "+CMS ERROR: 310" }))).rejects.toMatchObject({
      status: "no_sim",
    });
    await expect(sweepTransport(new FakeModem({ cpmsError: "+CME ERROR: 10" }))).rejects.toMatchObject({
      status: "no_sim",
    });
    await expect(sweepTransport(new FakeModem({ cpmsError: "ERROR" }))).rejects.toMatchObject({ status: "error" });
  });
});

describe("SmsReader", () => {
  it("joins concurrent callers onto one sweep and reuses it inside the window", async () => {
    let opens = 0;
    let t = 1_000_000;
    const reader = new SmsReader({
      resolvePort: () => "/dev/fake",
      openTransport: async () => {
        opens++;
        return new FakeModem({ stores: benchStores() });
      },
      now: () => t,
    });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(opens).toBe(1);
    expect(a).toBe(b);
    t += 4000;
    expect(await reader.read()).toBe(a);
    expect(opens).toBe(1);
    t += 2000;
    const c = await reader.read();
    expect(opens).toBe(2);
    expect(c).not.toBe(a);
    expect(c.status).toBe("ok");
  });

  it("reports no_modem when there is no port, and closes the transport on failure", async () => {
    expect((await new SmsReader({ resolvePort: () => null }).read()).status).toBe("no_modem");
    const fake = new FakeModem({ cpmsError: "+CMS ERROR: 310" });
    const r = await new SmsReader({ resolvePort: () => "/dev/x", openTransport: async () => fake }).read();
    expect(r.status).toBe("no_sim");
    expect(r.messages).toEqual([]);
    expect(fake.closed).toBe(true);
  });

  it("reports modem_busy when another process holds the lock", async () => {
    const home = tempHome();
    try {
      const lock = join(home, "sms.lock");
      writeFileSync(lock, String(process.pid)); // a live pid: ours
      const r = await new SmsReader({
        lockPath: lock,
        resolvePort: () => "/dev/x",
        openTransport: async () => new FakeModem({ stores: benchStores() }),
      }).read();
      expect(r.status).toBe("modem_busy");
    } finally {
      cleanup(home);
    }
  });
});

describe("acquireSmsLock", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => cleanup(home));

  it("takes a free lock, refuses a held one, and takes over a stale one", () => {
    const p = join(home, "l");
    const release = acquireSmsLock(p)!;
    expect(release).toBeTypeOf("function");
    expect(acquireSmsLock(p)).toBeNull();
    release();
    writeFileSync(p, "999999999"); // no such pid
    expect(acquireSmsLock(p)).toBeTypeOf("function");
  });
});

describe("resolveSmsPort", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => cleanup(home));

  /** Mimic /sys/class/tty/<n>/device -> <usbdev>/<iface>/<n>. */
  function fakeSys(ports: { name: string; iface: string; vendor: string }[]): string {
    const sys = join(home, "sys");
    mkdirSync(sys);
    for (const p of ports) {
      const usb = join(home, "usb", `${p.vendor}-${p.name}`);
      const iface = join(usb, `1.${p.iface}`);
      const dev = join(iface, p.name);
      mkdirSync(dev, { recursive: true });
      writeFileSync(join(usb, "idVendor"), `${p.vendor}\n`);
      writeFileSync(join(iface, "bInterfaceNumber"), `${p.iface}\n`);
      mkdirSync(join(sys, p.name));
      symlinkSync(dev, join(sys, p.name, "device"));
    }
    return sys;
  }

  it("finds interface 05 on the SIMCom device, by identity not name", () => {
    const sys = fakeSys([
      { name: "ttyUSB0", iface: "05", vendor: "0403" }, // some FTDI adapter
      { name: "ttyUSB3", iface: "04", vendor: "1e0e" },
      { name: "ttyUSB4", iface: "05", vendor: "1e0e" },
    ]);
    expect(resolveSmsPort({ sysClassTty: sys, env: {} })).toBe("/dev/ttyUSB4");
  });

  it("returns null with no match, and honours XORGATE_SMS_PORT", () => {
    const sys = fakeSys([{ name: "ttyUSB2", iface: "04", vendor: "1e0e" }]);
    expect(resolveSmsPort({ sysClassTty: sys, env: {} })).toBeNull();
    expect(resolveSmsPort({ sysClassTty: join(home, "nope"), env: {} })).toBeNull();
    expect(resolveSmsPort({ sysClassTty: sys, env: { XORGATE_SMS_PORT: "/dev/ttyACM9" } })).toBe("/dev/ttyACM9");
  });
});

describe("buildSmsPayload", () => {
  it("cuts to the limit per request and reports the full total", () => {
    const sweep = fixtureSmsSweep(Date.UTC(2026, 9, 1));
    const p = buildSmsPayload(sweep, { deviceId: "d", requestId: "r", limit: 2 });
    expect(p).toMatchObject({ v: 1, deviceId: "d", requestId: "r", status: "ok", error: null, total: 4, partial: false });
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]!.unread).toBe(true);
    expect(buildSmsPayload(sweep, { deviceId: "d", requestId: "r", limit: 999 }).messages).toHaveLength(4);
  });

  it("empties messages and total on failure", () => {
    const p = buildSmsPayload(
      { ...fixtureSmsSweep(0), status: "no_modem", error: "gone" },
      { deviceId: "d", requestId: "r", limit: 10 },
    );
    expect(p).toMatchObject({ status: "no_modem", error: "gone", total: 0, messages: [] });
  });

  it("the fixture inbox covers unread, alphanumeric and a joined message, newest first", () => {
    const s = fixtureSmsSweep(Date.UTC(2026, 9, 1));
    expect(s.messages.some((m) => m.unread)).toBe(true);
    expect(s.messages.some((m) => m.fromType === "alphanumeric")).toBe(true);
    expect(s.messages.some((m) => m.indexes.length > 1)).toBe(true);
    const ts = s.messages.map((m) => Date.parse(m.sentAt!));
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
  });

  it("never exceeds the 128 KB IoT limit, dropping the oldest and flagging partial", () => {
    const big = fixtureSmsSweep(0);
    const msg = { ...big.messages[0]!, text: "👍".repeat(2000), from: "+".padEnd(20, "9") };
    const p = buildSmsPayload({ ...big, messages: Array.from({ length: 50 }, () => msg) }, {
      deviceId: "x".repeat(36),
      requestId: "y".repeat(36),
      limit: 50,
    });
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(128 * 1024);
    expect(p.messages.length).toBeLessThan(50);
    expect(p.messages.length).toBeGreaterThan(10);
    expect(p.partial).toBe(true);
    expect(p.total).toBe(50);
    // The realistic case (the fixture) is untouched.
    expect(buildSmsPayload(fixtureSmsSweep(0), { deviceId: "d", requestId: "r", limit: 50 }).partial).toBe(false);
  });
});

describe("clampSmsLimit", () => {
  it("defaults, clamps and truncates", () => {
    expect(clampSmsLimit(undefined)).toBe(10);
    expect(clampSmsLimit("5")).toBe(10);
    expect(clampSmsLimit(Number.NaN)).toBe(10);
    expect(clampSmsLimit(0)).toBe(1);
    expect(clampSmsLimit(-3)).toBe(1);
    expect(clampSmsLimit(51)).toBe(50);
    expect(clampSmsLimit(12.9)).toBe(12);
    expect(clampSmsLimit(25)).toBe(25);
  });
});
