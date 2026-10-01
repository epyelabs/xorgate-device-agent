import { describe, expect, it } from "vitest";
import {
  assembleMessages,
  dcsAlphabet,
  decodePdu,
  decodeScts,
  SMS_TEXT_MAX,
  type DeliverPdu,
  type StoredPdu,
} from "../src/hardware/sms-pdu.js";
import { buildDeliver, buildSubmit, scts } from "./sms-pdu-builder.js";

const INTL = { kind: "international", value: "15550100001" } as const;

function deliver(hex: string, len?: number): DeliverPdu {
  const r = decodePdu(hex, len);
  if (r.kind !== "deliver") throw new Error(`expected deliver, got ${JSON.stringify(r)}`);
  return r;
}

describe("decodePdu: hand-checked vector", () => {
  // SMSC prefix shaped like the bench's (07915178850007F1…), a synthetic
  // +1 555 sender, the classic "hellohello" GSM-7 packing, and SCTS
  // 2026-08-11 20:05:59 with zone byte 0x69 = -16 quarters = -04:00.
  const HEX =
    "07915178850007F1" + "04" + "0B915155100000F1" + "00" + "00" + "62801102509569" + "0A" +
    "E8329BFD4697D9EC37";

  it("decodes sender, timestamp and text", () => {
    const d = deliver(HEX, 28);
    expect(d.from).toBe("+15550100001");
    expect(d.fromType).toBe("international");
    expect(d.sentAt).toBe("2026-08-11T20:05:59-04:00");
    expect(d.text).toBe("hellohello");
    expect(d.binary).toBe(false);
    expect(d.concat).toBeNull();
  });

  it("assumes the SMSC prefix when no length is given, and handles its absence", () => {
    expect(deliver(HEX).text).toBe("hellohello");
    expect(deliver(HEX.slice(16), 28).text).toBe("hellohello");
  });
});

describe("decodePdu: GSM-7", () => {
  it("round-trips the basic table", () => {
    const text = "Hello @ £$¥ èéùìò Ç Øø Åå Δ_ΦΓΛΩΠΨΣΘΞ Ææß É ¡ÄÖÑÜ§ ¿äöñüà 0123456789 !\"#¤%&'()*+,-./:;<=>?";
    const { pdu, length } = buildDeliver({ from: INTL, text });
    expect(deliver(pdu, length).text).toBe(text);
  });

  it("decodes the extension table", () => {
    const text = "price €5 [a] {b} ~c^ |d\\ e";
    const { pdu, length } = buildDeliver({ from: INTL, text });
    expect(deliver(pdu, length).text).toBe(text);
  });

  it("handles lengths that end on every septet boundary", () => {
    for (let n = 1; n <= 17; n++) {
      const text = "abcdefghijklmnopq".slice(0, n);
      const { pdu, length } = buildDeliver({ from: INTL, text });
      expect(deliver(pdu, length).text).toBe(text);
    }
  });

  it("an empty body decodes to empty text", () => {
    const { pdu, length } = buildDeliver({ from: INTL, text: "" });
    expect(deliver(pdu, length).text).toBe("");
  });
});

describe("decodePdu: UCS2 and 8-bit", () => {
  it("decodes UCS2 including surrogate pairs (emoji)", () => {
    const text = "Кириллица 東京 👍🏽 ok";
    const { pdu, length } = buildDeliver({ from: INTL, ucs2: text });
    expect(deliver(pdu, length).text).toBe(text);
  });

  it("returns 8-bit data as lowercase hex, flagged binary", () => {
    const { pdu, length } = buildDeliver({ from: INTL, data: [0x00, 0xff, 0x10, 0xab] });
    const d = deliver(pdu, length);
    expect(d.binary).toBe(true);
    expect(d.text).toBe("00ff10ab");
  });

  it("maps DCS groups to alphabets", () => {
    expect(dcsAlphabet(0x00)).toBe("gsm7");
    expect(dcsAlphabet(0x04)).toBe("8bit");
    expect(dcsAlphabet(0x08)).toBe("ucs2");
    expect(dcsAlphabet(0x10)).toBe("gsm7"); // class 0 flash
    expect(dcsAlphabet(0x18)).toBe("ucs2");
    expect(dcsAlphabet(0x24)).toBe("8bit"); // compressed
    expect(dcsAlphabet(0x48)).toBe("ucs2"); // auto-delete group
    expect(dcsAlphabet(0xf0)).toBe("gsm7");
    expect(dcsAlphabet(0xf4)).toBe("8bit");
    expect(dcsAlphabet(0xe0)).toBe("ucs2");
    expect(dcsAlphabet(0xc0)).toBe("gsm7");
  });
});

describe("decodePdu: senders", () => {
  it("decodes an alphanumeric sender verbatim", () => {
    for (const name of ["MYBANK", "Info-Line", "A", "XORGATE1234"]) {
      const { pdu, length } = buildDeliver({ from: { kind: "alphanumeric", value: name }, text: "x" });
      const d = deliver(pdu, length);
      expect(d.from).toBe(name);
      expect(d.fromType).toBe("alphanumeric");
    }
  });

  it("national and unknown-type numbers keep their digits, odd lengths drop the filler", () => {
    const n = deliver(buildDeliver({ from: { kind: "national", value: "5550100" }, text: "x" }).pdu);
    expect(n).toMatchObject({ from: "5550100", fromType: "national" });
    const u = deliver(buildDeliver({ from: { kind: "unknown", value: "12345" }, text: "x" }).pdu);
    expect(u).toMatchObject({ from: "12345", fromType: "other" });
  });
});

describe("decodeScts", () => {
  const b = (parts: number[]): Uint8Array => Uint8Array.from(parts);
  it("formats positive, negative and quarter-hour zones", () => {
    expect(decodeScts(b(scts(2026, 1, 2, 3, 4, 5, 0)))).toBe("2026-01-02T03:04:05+00:00");
    expect(decodeScts(b(scts(2026, 12, 31, 23, 59, 59, 8)))).toBe("2026-12-31T23:59:59+02:00");
    expect(decodeScts(b(scts(2026, 5, 1, 0, 0, 0, -16)))).toBe("2026-05-01T00:00:00-04:00");
    expect(decodeScts(b(scts(2026, 5, 1, 0, 0, 0, 23)))).toBe("2026-05-01T00:00:00+05:45");
    expect(decodeScts(b(scts(2026, 5, 1, 0, 0, 0, -38)))).toBe("2026-05-01T00:00:00-09:30");
  });

  it("is parseable by Date and keeps the instant", () => {
    const iso = decodeScts(b(scts(2026, 8, 11, 20, 5, 59, -16)))!;
    expect(new Date(iso).toISOString()).toBe("2026-08-12T00:05:59.000Z");
  });

  it("returns null for garbage", () => {
    expect(decodeScts(b([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBeNull();
    expect(decodeScts(b(scts(2026, 13, 1, 0, 0, 0, 0)))).toBeNull();
    expect(decodeScts(b([0x62, 0x80]))).toBeNull();
  });
});

describe("decodePdu: non-deliver and malformed", () => {
  it("skips SUBMIT and status-report PDUs", () => {
    const s = buildSubmit();
    expect(decodePdu(s.pdu, s.length)).toEqual({ kind: "skip", reason: "not-deliver" });
    expect(decodePdu("0006")).toEqual({ kind: "skip", reason: "not-deliver" });
  });

  it("reports malformed input instead of throwing", () => {
    expect(decodePdu("zz").kind).toBe("invalid");
    expect(decodePdu("").kind).toBe("invalid");
    expect(decodePdu("0").kind).toBe("invalid");
    expect(decodePdu("00040B91").kind).toBe("invalid");
    const { pdu, length } = buildDeliver({ from: INTL, text: "hello" });
    expect(decodePdu(pdu.slice(0, 40), length).kind).toBe("invalid");
  });
});

describe("decodePdu: concatenation headers", () => {
  it("reads IEI 0x00 (8-bit ref) and keeps GSM-7 septet alignment", () => {
    const { pdu, length } = buildDeliver({ from: INTL, text: "part one ", concat: { ref: 0x42, total: 2, seq: 1 } });
    const d = deliver(pdu, length);
    expect(d.concat).toEqual({ ref: 0x42, total: 2, seq: 1 });
    expect(d.text).toBe("part one ");
  });

  it("reads IEI 0x08 (16-bit ref) for UCS2", () => {
    const { pdu, length } = buildDeliver({
      from: INTL,
      ucs2: "東京",
      concat: { ref: 0x1234, total: 3, seq: 2, ref16: true },
    });
    const d = deliver(pdu, length);
    expect(d.concat).toEqual({ ref: 0x1234, total: 3, seq: 2 });
    expect(d.text).toBe("東京");
  });
});

// ---------------------------------------------------------------------------

let nextIndex = 0;
function rec(
  spec: Parameters<typeof buildDeliver>[0],
  over: Partial<StoredPdu> = {},
): StoredPdu {
  const { pdu, length } = buildDeliver(spec);
  return { storage: "SM", index: nextIndex++, stat: 1, length, pdu, ...over };
}

describe("assembleMessages", () => {
  it("joins a 3-part message in sequence order whatever the storage order", () => {
    const c = (seq: number) => ({ ref: 7, total: 3, seq });
    const r = assembleMessages([
      rec({ from: INTL, text: "three", concat: c(3) }, { index: 5 }),
      rec({ from: INTL, text: "one ", concat: c(1) }, { index: 3 }),
      rec({ from: INTL, text: "two ", concat: c(2) }, { index: 4, stat: 0 }),
    ]);
    expect(r.skipped).toBe(0);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      id: "SM:3+SM:4+SM:5",
      storage: "SM",
      indexes: [3, 4, 5],
      text: "one two three",
      unread: true, // any unread part makes the message unread
      incomplete: false,
      truncated: false,
      sentAt: "2026-08-11T20:05:59-04:00",
    });
  });

  it("rejoins an emoji split across UCS2 parts", () => {
    const thumbs = "👍";
    const c = (seq: number) => ({ ref: 300, total: 2, seq, ref16: true });
    const r = assembleMessages([
      rec({ from: INTL, ucs2: `a${thumbs[0]}`, concat: c(1) }),
      rec({ from: INTL, ucs2: `${thumbs[1]}b`, concat: c(2) }),
    ]);
    expect(r.messages[0]!.text).toBe(`a${thumbs}b`);
  });

  it("flags missing parts as incomplete and keeps what is there", () => {
    const r = assembleMessages([
      rec({ from: INTL, text: "first ", concat: { ref: 9, total: 3, seq: 1 } }),
      rec({ from: INTL, text: "last", concat: { ref: 9, total: 3, seq: 3 } }),
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ text: "first last", incomplete: true });
  });

  it("does not merge parts from different senders or totals sharing a ref", () => {
    const r = assembleMessages([
      rec({ from: INTL, text: "a", concat: { ref: 1, total: 2, seq: 1 } }),
      rec({ from: { kind: "alphanumeric", value: "BANK" }, text: "b", concat: { ref: 1, total: 2, seq: 1 } }),
      rec({ from: INTL, text: "c", concat: { ref: 1, total: 3, seq: 1 } }),
    ]);
    expect(r.messages).toHaveLength(3);
    expect(r.messages.every((m) => m.incomplete)).toBe(true);
  });

  it("splits two messages that reuse the same 8-bit ref", () => {
    const c = (seq: number) => ({ ref: 200, total: 2, seq });
    const r = assembleMessages([
      rec({ from: INTL, text: "A1", concat: c(1) }, { index: 0 }),
      rec({ from: INTL, text: "A2", concat: c(2) }, { index: 1 }),
      rec({ from: INTL, text: "B1", concat: c(1) }, { index: 2 }),
      rec({ from: INTL, text: "B2", concat: c(2) }, { index: 3 }),
    ]);
    expect(r.messages.map((m) => m.text).sort()).toEqual(["A1A2", "B1B2"]);
  });

  it("sorts newest first across stores, undecodable timestamps last", () => {
    const at = (d: number) => scts(2026, 8, d, 12, 0, 0, 0);
    const r = assembleMessages([
      rec({ from: INTL, text: "old", scts: at(1) }, { storage: "ME", index: 0 }),
      rec({ from: INTL, text: "new", scts: at(20) }, { storage: "SM", index: 0 }),
      rec({ from: INTL, text: "mid", scts: at(10) }, { storage: "ME", index: 1 }),
      rec({ from: INTL, text: "bad", scts: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] }, { storage: "SM", index: 1 }),
    ]);
    expect(r.messages.map((m) => m.text)).toEqual(["new", "mid", "old", "bad"]);
    expect(r.messages[3]!.sentAt).toBeNull();
  });

  it("orders by instant, not by wall clock, across zones", () => {
    const r = assembleMessages([
      // 12:00 at -04:00 = 16:00Z
      rec({ from: INTL, text: "later", scts: scts(2026, 8, 1, 12, 0, 0, -16) }),
      // 14:00 at +00:00 = 14:00Z
      rec({ from: INTL, text: "earlier", scts: scts(2026, 8, 1, 14, 0, 0, 0) }),
    ]);
    expect(r.messages.map((m) => m.text)).toEqual(["later", "earlier"]);
  });

  it("counts skipped and invalid PDUs", () => {
    const s = buildSubmit();
    const r = assembleMessages([
      rec({ from: INTL, text: "ok" }),
      { storage: "SM", index: 50, stat: 2, length: s.length, pdu: s.pdu },
      { storage: "ME", index: 51, stat: 1, pdu: "nothex" },
    ]);
    expect(r.skipped).toBe(2);
    expect(r.messages).toHaveLength(1);
  });

  it("truncates long text at the cap without splitting a surrogate pair", () => {
    // 67 UCS2 chars per part x 70 parts is far over 4000.
    const parts: StoredPdu[] = [];
    for (let i = 1; i <= 70; i++) {
      parts.push(rec({ from: INTL, ucs2: "x".repeat(66) + (i === 60 ? "👍".slice(0, 1) : "y"), concat: { ref: 3, total: 70, seq: i } }));
    }
    const r = assembleMessages(parts);
    expect(r.messages[0]!.truncated).toBe(true);
    expect(r.messages[0]!.text.length).toBeLessThanOrEqual(SMS_TEXT_MAX);

    const emojiAtCap = "a".repeat(SMS_TEXT_MAX - 1) + "👍";
    const chunk = 60;
    const big: StoredPdu[] = [];
    const total = Math.ceil(emojiAtCap.length / chunk);
    for (let i = 0; i < total; i++) {
      big.push(rec({ from: INTL, ucs2: emojiAtCap.slice(i * chunk, (i + 1) * chunk), concat: { ref: 4, total, seq: i + 1 } }));
    }
    const m = assembleMessages(big).messages[0]!;
    expect(m.truncated).toBe(true);
    expect(m.text).toBe("a".repeat(SMS_TEXT_MAX - 1));
  });
});
