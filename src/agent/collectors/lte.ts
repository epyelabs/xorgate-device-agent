import type { Collector } from "./index.js";

/**
 * LTE signal collector (rssi / quality).
 *
 * P5 STUB. Real implementation issues `AT+CSQ` over the modem serial port (e.g.
 * /dev/ttyUSB2 @ 115200), parses `+CSQ: <rssi>,<ber>`, and maps the 0–31 ASU
 * scale to dBm (cf. prototyping/alc-hw-tracker-pro/lteSerial.js).
 */
export function createLteCollector(): Collector {
  return {
    group: "lte",
    async read() {
      return {}; // TODO(P5): { rssi:{value,unit:'dBm'}, quality:{value,unit:'asu'} }
    },
  };
}
