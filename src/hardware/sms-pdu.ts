/**
 * SMS PDU decoding (device-sms-inbox plan §2.3). Pure, no I/O, no deps.
 *
 * Input is what the SIM7600 returns for `AT+CMGRO=<i>` in PDU mode
 * (`AT+CMGF=0`): a `+CMGRO: <stat>,<alpha>,<length>` header, then one hex line
 * that starts with the SMSC address (`07915178…`) followed by the TPDU.
 * `<length>` is the TPDU length in octets, which is how we tell whether the
 * SMSC prefix is there at all.
 *
 * Only SMS-DELIVER is decoded. Stored SUBMIT PDUs (drafts / sent copies) and
 * status reports come back as `{ kind: "skip" }` and are counted, never shown.
 *
 * Privacy (contract §6): nothing in here logs. Callers must not log `from` or
 * `text` either.
 */

export type SenderType = "international" | "national" | "alphanumeric" | "other";

export interface ConcatInfo {
  /** Reference number (8-bit for IEI 0x00, 16-bit for IEI 0x08). */
  ref: number;
  total: number;
  /** 1-based sequence number of this part. */
  seq: number;
}

export interface DeliverPdu {
  kind: "deliver";
  from: string;
  fromType: SenderType;
  /** SCTS as ISO 8601 with its own offset, or null when undecodable. */
  sentAt: string | null;
  /** Decoded text, or a lowercase hex string when `binary`. */
  text: string;
  binary: boolean;
  concat: ConcatInfo | null;
}

export type PduDecodeResult =
  | DeliverPdu
  | { kind: "skip"; reason: "not-deliver" }
  | { kind: "invalid"; reason: string };

// ---------------------------------------------------------------------------
// GSM 03.38 default alphabet + extension table
// ---------------------------------------------------------------------------

/** 0x1B (ESC) is a placeholder here; it is handled as the extension escape. */
const GSM7_BASIC: readonly string[] = [
  "@", "£", "$", "¥", "è", "é", "ù", "ì", "ò", "Ç", "\n", "Ø", "ø", "\r", "Å", "å",
  "Δ", "_", "Φ", "Γ", "Λ", "Ω", "Π", "Ψ", "Σ", "Θ", "Ξ", "\u001b", "Æ", "æ", "ß", "É",
  " ", "!", '"', "#", "¤", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?",
  "¡", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O",
  "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "Ä", "Ö", "Ñ", "Ü", "§",
  "¿", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o",
  "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "ä", "ö", "ñ", "ü", "à",
];

const GSM7_EXT: Readonly<Record<number, string>> = {
  0x0a: "\f",
  0x14: "^",
  0x28: "{",
  0x29: "}",
  0x2f: "\\",
  0x3c: "[",
  0x3d: "~",
  0x3e: "]",
  0x40: "|",
  0x65: "€",
};

export const GSM7_BASIC_TABLE = GSM7_BASIC;
export const GSM7_EXT_TABLE = GSM7_EXT;

/** Unpack `count` septets starting at bit 0 of `bytes`. */
export function unpackSeptets(bytes: Uint8Array, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const bit = i * 7;
    const byte = bit >> 3;
    const shift = bit & 7;
    if (byte >= bytes.length) break;
    let v = bytes[byte]! >> shift;
    if (shift > 1 && byte + 1 < bytes.length) v |= bytes[byte + 1]! << (8 - shift);
    out.push(v & 0x7f);
  }
  return out;
}

/** Septet codes -> text, honouring the 0x1B extension escape. */
export function gsm7ToString(septets: readonly number[]): string {
  let s = "";
  for (let i = 0; i < septets.length; i++) {
    const c = septets[i]!;
    if (c === 0x1b) {
      const next = septets[i + 1];
      if (next === undefined) break; // dangling escape at the end: drop it
      i++;
      // 23.038: an unknown extension code displays as the basic-table char.
      s += GSM7_EXT[next] ?? (next === 0x1b ? " " : GSM7_BASIC[next]!);
      continue;
    }
    s += GSM7_BASIC[c]!;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.trim();
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const BCD_EXTRA = ["*", "#", "a", "b", "c"]; // nibbles 0xA..0xE; 0xF is filler

/** Swapped-nibble BCD digits (address values). Stops at the 0xF filler. */
function semiOctets(bytes: Uint8Array, digits: number): string {
  let s = "";
  for (let i = 0; i < digits; i++) {
    const b = bytes[i >> 1];
    if (b === undefined) break;
    const nib = i % 2 === 0 ? b & 0x0f : b >> 4;
    if (nib === 0x0f) break;
    s += nib < 10 ? String(nib) : BCD_EXTRA[nib - 10]!;
  }
  return s;
}

/** One SCTS field octet: low nibble is the tens digit. NaN on a non-BCD nibble. */
function bcdField(b: number): number {
  const lo = b & 0x0f;
  const hi = b >> 4;
  if (lo > 9 || hi > 9) return Number.NaN;
  return lo * 10 + hi;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * SCTS (7 octets) -> `YYYY-MM-DDThh:mm:ss±hh:mm`. The zone is in quarter
 * hours, with the sign in bit 3 of the low (tens) nibble (23.040 §9.2.3.11).
 */
export function decodeScts(b: Uint8Array): string | null {
  if (b.length < 7) return null;
  const [yy, mo, dd, hh, mi, ss] = [0, 1, 2, 3, 4, 5].map((i) => bcdField(b[i]!));
  const tzByte = b[6]!;
  const tzTens = tzByte & 0x07;
  const tzUnits = tzByte >> 4;
  const negative = (tzByte & 0x08) !== 0;
  if ([yy, mo, dd, hh, mi, ss].some((n) => Number.isNaN(n)) || tzUnits > 9) return null;
  if (mo! < 1 || mo! > 12 || dd! < 1 || dd! > 31 || hh! > 23 || mi! > 59 || ss! > 59) return null;
  const quarters = tzTens * 10 + tzUnits;
  if (quarters > 18 * 4) return null;
  const offMin = quarters * 15;
  const tz = `${negative && offMin > 0 ? "-" : "+"}${pad2(Math.floor(offMin / 60))}:${pad2(offMin % 60)}`;
  return `${2000 + yy!}-${pad2(mo!)}-${pad2(dd!)}T${pad2(hh!)}:${pad2(mi!)}:${pad2(ss!)}${tz}`;
}

function decodeAddress(
  digits: number,
  toa: number,
  body: Uint8Array,
): { from: string; fromType: SenderType } {
  const ton = (toa >> 4) & 0x07;
  if (ton === 0x05) {
    // Alphanumeric: GSM-7 packed; `digits` counts the semi-octets used.
    const septets = Math.floor((digits * 4) / 7);
    return { from: gsm7ToString(unpackSeptets(body, septets)), fromType: "alphanumeric" };
  }
  const num = semiOctets(body, digits);
  if (ton === 0x01) return { from: `+${num}`, fromType: "international" };
  if (ton === 0x02) return { from: num, fromType: "national" };
  return { from: num, fromType: "other" };
}

type Alphabet = "gsm7" | "8bit" | "ucs2";

/** 23.038 §4 data coding scheme -> alphabet. Compressed text is treated as 8-bit. */
export function dcsAlphabet(dcs: number): Alphabet {
  const group = dcs >> 4;
  if (group <= 0x07) {
    // General data coding (00xx) and automatic-deletion (01xx) groups.
    if (dcs & 0x20) return "8bit"; // compressed
    const a = (dcs >> 2) & 0x03;
    if (a === 0x01) return "8bit";
    if (a === 0x02) return "ucs2";
    return "gsm7";
  }
  if (group === 0x0f) return dcs & 0x04 ? "8bit" : "gsm7";
  if (group === 0x0e) return "ucs2"; // MWI, store, UCS2
  return "gsm7"; // 0xC/0xD MWI groups, and the reserved 0x8..0xB
}

function decodeUcs2(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    // Code units, not code points: a surrogate pair split across two
    // concatenated parts rejoins when the part strings are joined.
    s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return s;
}

function parseUdh(udh: Uint8Array): ConcatInfo | null {
  let concat: ConcatInfo | null = null;
  let i = 0;
  while (i + 1 < udh.length) {
    const iei = udh[i]!;
    const len = udh[i + 1]!;
    const data = udh.subarray(i + 2, i + 2 + len);
    if (data.length < len) break;
    if (iei === 0x00 && len === 3 && data[1]! > 0 && data[2]! > 0) {
      concat = { ref: data[0]!, total: data[1]!, seq: data[2]! };
    } else if (iei === 0x08 && len === 4 && data[2]! > 0 && data[3]! > 0) {
      concat = { ref: (data[0]! << 8) | data[1]!, total: data[2]!, seq: data[3]! };
    }
    i += 2 + len;
  }
  return concat;
}

/**
 * Decode one stored PDU.
 *
 * @param tpduLength the `<length>` from the `+CMGRO`/`+CMGR` header (TPDU
 *   octets, SMSC excluded). When the line is exactly that long there is no
 *   SMSC prefix; otherwise the first octet is the SMSC length. Omit it to
 *   assume the prefix is present (what the SIM7600 always sends).
 */
export function decodePdu(hex: string, tpduLength?: number): PduDecodeResult {
  const all = hexToBytes(hex);
  if (!all) return { kind: "invalid", reason: "not hex" };
  let p = 0;
  if (tpduLength === undefined || all.length !== tpduLength) {
    p = 1 + all[0]!;
  }
  const b = all.subarray(p);
  if (b.length < 1) return { kind: "invalid", reason: "truncated" };
  const first = b[0]!;
  if ((first & 0x03) !== 0x00) return { kind: "skip", reason: "not-deliver" };
  const udhi = (first & 0x40) !== 0;

  let i = 1;
  const oaDigits = b[i++];
  const toa = b[i++];
  if (oaDigits === undefined || toa === undefined) return { kind: "invalid", reason: "truncated" };
  const oaOctets = Math.ceil(oaDigits / 2);
  const oaBody = b.subarray(i, i + oaOctets);
  if (oaBody.length < oaOctets) return { kind: "invalid", reason: "truncated" };
  i += oaOctets;
  const { from, fromType } = decodeAddress(oaDigits, toa, oaBody);

  /* const pid = */ i++;
  const dcs = b[i++];
  if (dcs === undefined) return { kind: "invalid", reason: "truncated" };
  const scts = b.subarray(i, i + 7);
  if (scts.length < 7) return { kind: "invalid", reason: "truncated" };
  i += 7;
  const sentAt = decodeScts(scts);
  const udl = b[i++];
  if (udl === undefined) return { kind: "invalid", reason: "truncated" };
  const ud = b.subarray(i);

  const alphabet = dcsAlphabet(dcs);
  let concat: ConcatInfo | null = null;
  let headerOctets = 0;
  if (udhi && ud.length > 0) {
    headerOctets = 1 + ud[0]!;
    if (headerOctets > ud.length) return { kind: "invalid", reason: "bad UDH" };
    concat = parseUdh(ud.subarray(1, headerOctets));
  }

  if (alphabet === "gsm7") {
    // UDL counts septets, header included; the header is padded to a septet
    // boundary, so skip ceil(headerBits / 7) septets.
    const skip = Math.ceil((headerOctets * 8) / 7);
    const septets = unpackSeptets(ud, udl).slice(skip);
    return { kind: "deliver", from, fromType, sentAt, text: gsm7ToString(septets), binary: false, concat };
  }
  // 8-bit and UCS2: UDL counts octets, header included.
  const body = ud.subarray(headerOctets, Math.min(udl, ud.length));
  if (alphabet === "ucs2") {
    return { kind: "deliver", from, fromType, sentAt, text: decodeUcs2(body), binary: false, concat };
  }
  return { kind: "deliver", from, fromType, sentAt, text: bytesToHex(body), binary: true, concat };
}

// ---------------------------------------------------------------------------
// Assembly: stored PDUs -> contract messages
// ---------------------------------------------------------------------------

export type SmsStorage = "SM" | "ME";

/** One `AT+CMGRO` answer, as read off the modem. */
export interface StoredPdu {
  storage: SmsStorage;
  index: number;
  /** `<stat>` from the header: 0 = REC UNREAD, 1 = REC READ (2/3 = stored MO). */
  stat: number;
  /** TPDU length from the header, if known. */
  length?: number;
  pdu: string;
}

/** Contract §2 message shape. */
export interface SmsMessage {
  id: string;
  storage: SmsStorage;
  indexes: number[];
  from: string;
  fromType: SenderType;
  sentAt: string | null;
  unread: boolean;
  text: string;
  binary: boolean;
  incomplete: boolean;
  truncated: boolean;
}

export const SMS_TEXT_MAX = 4000;

interface Part {
  rec: StoredPdu;
  pdu: DeliverPdu;
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= SMS_TEXT_MAX) return { text, truncated: false };
  let cut = SMS_TEXT_MAX;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--; // never split a surrogate pair
  return { text: text.slice(0, cut), truncated: true };
}

function sentAtMs(m: SmsMessage): number {
  if (m.sentAt === null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(m.sentAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function buildMessage(parts: Part[], total: number | null): SmsMessage {
  const sorted = [...parts].sort((a, b) => (a.pdu.concat?.seq ?? 0) - (b.pdu.concat?.seq ?? 0));
  const head = sorted[0]!;
  const joined = sorted.map((p) => p.pdu.text).join("");
  const { text, truncated } = truncateText(joined);
  return {
    id: sorted.map((p) => `${p.rec.storage}:${p.rec.index}`).join("+"),
    storage: head.rec.storage,
    indexes: sorted.map((p) => p.rec.index),
    from: head.pdu.from,
    fromType: head.pdu.fromType,
    sentAt: head.pdu.sentAt,
    unread: sorted.some((p) => p.rec.stat === 0),
    text,
    binary: sorted.some((p) => p.pdu.binary),
    incomplete: total !== null && sorted.length < total,
    truncated,
  };
}

/**
 * Decode, join concatenated parts, sort newest first.
 *
 * Parts group by `(from, ref, total)`. An 8-bit reference wraps, so the same
 * key can hold two different messages: a part goes to the first group of its
 * key that does not have its sequence number yet (parts are visited in
 * storage/index order, which is arrival order on this modem).
 */
export function assembleMessages(records: readonly StoredPdu[]): {
  messages: SmsMessage[];
  skipped: number;
} {
  let skipped = 0;
  const singles: Part[][] = [];
  const groups = new Map<string, Part[][]>();
  const ordered = [...records].sort((a, b) =>
    a.storage === b.storage ? a.index - b.index : a.storage < b.storage ? -1 : 1,
  );
  for (const rec of ordered) {
    let pdu: PduDecodeResult;
    try {
      pdu = decodePdu(rec.pdu, rec.length);
    } catch {
      pdu = { kind: "invalid", reason: "decoder threw" };
    }
    if (pdu.kind !== "deliver") {
      skipped++;
      continue;
    }
    const part: Part = { rec, pdu };
    const c = pdu.concat;
    if (c === null || c.total <= 1) {
      singles.push([part]);
      continue;
    }
    const key = `${pdu.from}\u0000${c.ref}\u0000${c.total}`;
    const list = groups.get(key) ?? [];
    let home = list.find((g) => !g.some((p) => p.pdu.concat!.seq === c.seq));
    if (!home) {
      home = [];
      list.push(home);
    }
    home.push(part);
    groups.set(key, list);
  }
  const messages: SmsMessage[] = singles.map((g) => buildMessage(g, null));
  for (const list of groups.values()) {
    for (const g of list) messages.push(buildMessage(g, g[0]!.pdu.concat!.total));
  }
  messages.sort((a, b) => {
    const d = sentAtMs(b) - sentAtMs(a);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return { messages, skipped };
}
