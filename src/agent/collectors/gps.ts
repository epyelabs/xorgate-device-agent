import type { Collector } from "./index.js";

/**
 * GPS collector (lat / lon / alt / speed).
 *
 * P5 STUB. Real implementation reads NMEA from a serial modem (e.g.
 * /dev/ttyUSB1 @ 115200) and parses $GPGGA/$GPRMC/$GPVTG (cf.
 * prototyping/alc-hw-tracker-pro/gpsSerial.js + index.js).
 */
export function createGpsCollector(): Collector {
  return {
    group: "gps",
    async read() {
      return {}; // TODO(P5): { lat:{value}, lon:{value}, alt:{value,unit:'m'}, speed:{value,unit:'km/h'} }
    },
  };
}
