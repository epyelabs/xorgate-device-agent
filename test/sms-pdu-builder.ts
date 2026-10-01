/**
 * Test-only SMS-DELIVER PDU encoder, so fixtures are synthetic (no real
 * numbers or bodies from the bench are ever committed).
 */
import { GSM7_BASIC_TABLE, GSM7_EXT_TABLE } from "../src/hardware/sms-pdu.js";

const hex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");

/** Text -> GSM-7 septets (with escapes for the extension table). */
export function toSeptets(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const basic = GSM7_BASIC_TABLE.indexOf(ch);
    if (basic >= 0 && basic !== 0x1b) {
      out.push(basic);
      continue;
    }
    const ext = Object.entries(GSM7_EXT_TABLE).find(([, v]) => v === ch);
    if (!ext) throw new Error(`not GSM-7: ${ch}`);
    out.push(0x1b, Number(ext[0]));
  }
  return out;
}

/** Pack septets starting `fillBits` bits into the buffer. */
export function packSeptets(septets: number[], fillBits = 0): number[] {
  const totalBits = fillBits + septets.length * 7;
  const out = new Array<number>(Math.ceil(totalBits / 8)).fill(0);
  septets.forEach((s, i) => {
    const bit = fillBits + i * 7;
    const byte = bit >> 3;
    const shift = bit & 7;
    out[byte]! |= (s << shift) & 0xff;
    if (shift > 1) out[byte + 1]! |= s >> (8 - shift);
  });
  return out;
}

function bcdDigits(digits: string): number[] {
  const d = digits.length % 2 ? `${digits}F` : digits;
  const out: number[] = [];
  for (let i = 0; i < d.length; i += 2) out.push(parseInt(`${d[i + 1]}${d[i]}`, 16));
  return out;
}

export interface SenderSpec {
  kind: "international" | "national" | "alphanumeric" | "unknown";
  value: string;
}

function address(s: SenderSpec): number[] {
  if (s.kind === "alphanumeric") {
    const septets = toSeptets(s.value);
    const packed = packSeptets(septets);
    return [Math.ceil((septets.length * 7) / 4), 0xd0, ...packed];
  }
  const toa = s.kind === "international" ? 0x91 : s.kind === "national" ? 0xa1 : 0x81;
  return [s.value.length, toa, ...bcdDigits(s.value)];
}

/** Date parts + zone in quarter hours (negative allowed) -> 7 SCTS octets. */
export function scts(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tzQuarters: number,
): number[] {
  const sw = (n: number): number => ((n % 10) << 4) | Math.floor(n / 10);
  const q = Math.abs(tzQuarters);
  const tz = ((q % 10) << 4) | Math.floor(q / 10) | (tzQuarters < 0 ? 0x08 : 0);
  return [sw(y % 100), sw(mo), sw(d), sw(h), sw(mi), sw(s), tz];
}

export interface DeliverSpec {
  from: SenderSpec;
  text?: string;
  /** Raw UCS2 text (encoded as UTF-16BE code units). */
  ucs2?: string;
  /** 8-bit payload. */
  data?: number[];
  scts?: number[];
  concat?: { ref: number; total: number; seq: number; ref16?: boolean };
  /** Prefix an SMSC address (default true, like the SIM7600). */
  smsc?: boolean;
}

export const DEFAULT_SCTS = scts(2026, 8, 11, 20, 5, 59, -16);

/** Build an SMS-DELIVER PDU. Returns the hex line and the TPDU length for the header. */
export function buildDeliver(spec: DeliverSpec): { pdu: string; length: number } {
  const udh: number[] = [];
  if (spec.concat) {
    const c = spec.concat;
    if (c.ref16) udh.push(0x08, 0x04, c.ref >> 8, c.ref & 0xff, c.total, c.seq);
    else udh.push(0x00, 0x03, c.ref, c.total, c.seq);
  }
  const header = udh.length ? [udh.length, ...udh] : [];
  let dcs: number;
  let udl: number;
  let ud: number[];
  if (spec.data) {
    dcs = 0x04;
    ud = [...header, ...spec.data];
    udl = ud.length;
  } else if (spec.ucs2 !== undefined) {
    dcs = 0x08;
    const body: number[] = [];
    for (let i = 0; i < spec.ucs2.length; i++) {
      const u = spec.ucs2.charCodeAt(i);
      body.push(u >> 8, u & 0xff);
    }
    ud = [...header, ...body];
    udl = ud.length;
  } else {
    dcs = 0x00;
    const septets = toSeptets(spec.text ?? "");
    const fillSeptets = Math.ceil((header.length * 8) / 7);
    const packed = packSeptets(septets, fillSeptets * 7);
    // Overlay the header octets at the start.
    header.forEach((b, i) => (packed[i] = b));
    ud = packed;
    udl = fillSeptets + septets.length;
  }
  const first = 0x04 | (header.length ? 0x40 : 0);
  const tpdu = [first, ...address(spec.from), 0x00, dcs, ...(spec.scts ?? DEFAULT_SCTS), udl, ...ud];
  const smsc = spec.smsc === false ? [] : [0x07, 0x91, 0x51, 0x78, 0x85, 0x00, 0x07, 0xf1];
  return { pdu: hex([...smsc, ...tpdu]), length: tpdu.length };
}

/** A stored SMS-SUBMIT (draft/sent copy) PDU, which the reader must skip. */
export function buildSubmit(): { pdu: string; length: number } {
  const tpdu = [0x01, 0x00, 0x0b, 0x91, ...bcdDigits("15550100009"), 0x00, 0x00, 0x02, 0xc8, 0x34];
  return { pdu: `00${hex(tpdu)}`, length: tpdu.length };
}
