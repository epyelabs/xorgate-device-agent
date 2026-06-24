import { describe, expect, it } from "vitest";
import {
  ifaceForIp,
  isVirtualIface,
  parseDeviceEnabled,
  parseWifiDevice,
  sortInterfaces,
  sshServerIp,
} from "../src/hardware/network.js";

describe("isVirtualIface", () => {
  it("hides loopback and virtual devices", () => {
    for (const n of ["lo", "p2p-dev-wlan0", "veth123", "docker0", "br-abc", "virbr0", "tun0", "tap0"]) {
      expect(isVirtualIface(n)).toBe(true);
    }
  });

  it("keeps real interfaces", () => {
    for (const n of ["eth0", "eth1", "usb0", "wlan0", "wlp2s0", "enp3s0"]) {
      expect(isVirtualIface(n)).toBe(false);
    }
  });
});

describe("sortInterfaces", () => {
  it("orders eth*, usb*, wlan*, then the rest, lexically within a rank", () => {
    expect(sortInterfaces(["wlan0", "usb0", "eth1", "eth0", "ztabc"])).toEqual([
      "eth0",
      "eth1",
      "usb0",
      "wlan0",
      "ztabc",
    ]);
  });
});

describe("parseWifiDevice", () => {
  const NMCLI = ["usb0:ethernet", "wlan0:wifi", "lo:loopback", "p2p-dev-wlan0:wifi-p2p"].join("\n");

  it("finds the first wifi device", () => {
    expect(parseWifiDevice(NMCLI)).toBe("wlan0");
  });

  it("returns null when there is no wifi device", () => {
    expect(parseWifiDevice("eth0:ethernet\nlo:loopback")).toBeNull();
  });
});

describe("parseDeviceEnabled", () => {
  const NMCLI = ["usb0:connected", "wlan0:disconnected", "eth0:unavailable"].join("\n");

  it("treats connected/connecting as enabled", () => {
    expect(parseDeviceEnabled("wlan0:connected", "wlan0")).toBe(true);
    expect(parseDeviceEnabled("wlan0:connecting", "wlan0")).toBe(true);
  });

  it("treats disconnected/unavailable as disabled", () => {
    expect(parseDeviceEnabled(NMCLI, "wlan0")).toBe(false);
    expect(parseDeviceEnabled(NMCLI, "eth0")).toBe(false);
  });

  it("returns false for an unknown device", () => {
    expect(parseDeviceEnabled(NMCLI, "wlan9")).toBe(false);
  });
});

describe("sshServerIp", () => {
  it("extracts the server IP (3rd field) from $SSH_CONNECTION", () => {
    expect(sshServerIp("10.0.0.5 51514 10.0.0.111 22")).toBe("10.0.0.111");
  });

  it("returns null when unset or malformed", () => {
    expect(sshServerIp(undefined)).toBeNull();
    expect(sshServerIp("")).toBeNull();
    expect(sshServerIp("only two")).toBeNull();
  });
});

describe("ifaceForIp", () => {
  it("returns null for a null/absent IP", () => {
    expect(ifaceForIp(null)).toBeNull();
    expect(ifaceForIp("203.0.113.7")).toBeNull(); // not on any local iface
  });
});
