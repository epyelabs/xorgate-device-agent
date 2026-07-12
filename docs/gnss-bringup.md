# GNSS bring-up notes (SIM7600G-H)

Field notes from the 2026-07 GPS/TTFF work: what the modem is actually
configured to do, the quirks we hit on real hardware, how to verify a device,
and the antenna guidance. The README's **GPS / GNSS** section covers the
day-to-day behavior; this doc is the deeper reference for debugging and for
bringing up new hardware revisions.

Reference device: SIM7600G-H-M.2 on a CM5 carrier, firmware `LE20B04SIM7600G-H-M2`.

## The problem this solves

Slow (multi-minute) or absent first fixes in urban areas with partial sky
view. Root cause was twofold:

1. **No assistance.** The old flow was a bare `AT+CGPS=1` (standalone). A
   standalone cold start must demodulate ephemeris from each satellite's
   50 bit/s broadcast, which needs roughly -144 dBm or better. Urban canyons
   let the receiver *track* satellites well below that but not *decode* them,
   so acquisition stalls indefinitely.
2. **Weak antenna.** A passive combined 4G/GPS FPC antenna, no LNA, LTE
   radiator on the same flex. SIMCom's hardware design guide explicitly says
   passive antennas need an external LNA (the module has no bias supply and
   limited front-end gain).

Software (1) is fixed by `modem/sim7600-lte.sh`; hardware (2) needs an active
antenna (see the last section).

## What the daemon configures (and why)

All of this is idempotent: settings are read back first and only written on
drift, and the one-time `AT+CRESET` fires only when a changed setting needs a
module restart to take effect. A normal boot makes zero config writes.

| Setting | Command | Why |
| --- | --- | --- |
| All constellations, DPO off | `AT+CGNSSMODE=15,0` | GPS+GLONASS+BDS+GAL+QZSS ≈ doubles satellites in view; DPO duty-cycling trades sensitivity for power, we want sensitivity. Needs LE20-era firmware. |
| XTRA enabled | `AT+CGPSXE=1` (reboot to apply) | Predicted ephemeris file (~40 kB, ~7 days validity) downloaded over LTE; removes the demodulation requirement entirely. Biggest single TTFF win. |
| XTRA auto-inject | `AT+CGPSXDAUTO=1` | Injects the stored file at every GPS start. |
| SUPL server | `AT+CGPSURL="supl.google.com:7276"` + `AT+CGPSSSL=0` (reboot to apply) | UE-based AGPS when data is up. Port 7276 is plain TCP; 7275 needs a carrier TLS cert. |
| Start mode | `AT+CGPS=1,2` | UE-based; the modem auto-falls back to standalone if the SUPL server is unreachable. |
| Accuracy threshold | `AT+CGPSHOR=100` (factory 50) | Allows an early coarse fix in bad geometry; it refines afterward. |
| NMEA mask | `AT+CGPSNMEA=197119` | GGA+RMC+VTG plus the GSA/GSV variants for every constellation — the agent needs GSA (hdop) and GSV (sats in view). |

Runtime upkeep while the link is healthy:

- **XTRA refresh**: validity checked via `AT+CGPSXTRADATA?` every 6 h;
  re-downloaded (`AT+CGPSXD=0`) when under 1 day remains; failed downloads
  retry after 10 min. Current validity is published as `xtra_valid_min` in
  `/run/sim7600-lte/telemetry.json`.
- **Engine re-assert** every 10 min: a modem-side reset comes back with GNSS
  off (`AT+CGPSAUTO=0`), so the daemon restarts it.

## Hardware quirks we hit (read before touching the flow)

- **`AT+CGPSXDAUTO=1` fails until XTRA is live.** It returns
  `+CME ERROR: XTRA Disabled` if sent before the post-`CGPSXE=1` reboot. The
  daemon sets it *after* the reset block for this reason. Symptom of getting
  it wrong: `AT+CGPSXDAUTO?` stubbornly reads 0.
- **`AT+CHTPUPDATE` can just `ERROR`.** On our SIM (APN `sp.mb.com`) HTP time
  sync fails outright, and `AT+CHTPSERV?` won't even retain the ADD. XTRA
  needs an accurate clock, but NITZ already provides it on this carrier —
  check `AT+CCLK?`. The daemon therefore treats NITZ as primary and only
  attempts HTP when the clock year is obviously bogus (< 2024).
- **Don't trust the `+CGPSXD` URC; re-query.** The download-result URC can
  slip between two reads of the AT port (the shell helpers open/close the tty
  per command). The daemon triggers the download, then decides success by
  re-reading `AT+CGPSXTRADATA?` validity.
- **Per-constellation GSA clobbering.** The SIM7600 emits one GSA per
  constellation. A constellation without a fix emits `$BDGSA,A,1,,,...` with
  *empty* DOP fields. Naively merging that wipes the hdop the GPS GSA just
  reported. The parser ignores `fixType 1` GSA sentences; true lock loss is
  signalled by GGA quality 0 / void RMC (which clear position **and** hdop).
- **XTRA survives `AT+CGPSDEL` and reboots.** The file lives in module flash.
  `CGPSDEL` wipes the *demodulated/computed* aiding (forces a cold start) but
  the next start re-injects XTRA — which is exactly what makes the assisted
  cold start fast.
- **Full SMS storage spams the AT port.** `+SMS FULL` URCs interleave with
  command responses and can confuse naive parsers. Clear with `AT+CMGD=1,4`.
- **Mode 3 (UE-assisted, `AT+CGPS=1,3`) is broken with public SUPL servers**
  — it immediately self-stops (`+CGPS: 0`). Known community-wide; don't use.
- **One AT-port owner.** The daemon owns `/dev/ttyUSB2`. A second reader
  steals response bytes from the first. Stop `sim7600-lte.service` before any
  manual AT session.

## Verifying a device

Quick health read (no AT port needed):

```sh
journalctl -u sim7600-lte -f | grep -E "GNSS|XTRA"
cat /run/sim7600-lte/telemetry.json          # xtra_valid_min should be > 1440
xorgate manage                                # GPS pane: sats used/in-view, hdop
```

Manual AT probe (stop the daemon first: `sudo systemctl stop sim7600-lte`):

```sh
PORT=/dev/ttyUSB2; stty -F $PORT 115200 raw -echo
send() { printf '%s\r' "$1" > $PORT; timeout "${2:-2}" cat $PORT | tr -d '\r'; }
send 'AT+CGMR'            # want LE20+ firmware
send 'AT+CGNSSMODE?'      # want 15,0
send 'AT+CGPS?'           # want 1,2 (or 1,1 fallback)
send 'AT+CGPSXE?'         # want 1
send 'AT+CGPSXTRADATA?'   # want validity minutes > 1440
send 'AT+CGPSINFO'        # position when fixed
```

### Cold-start TTFF measurement

Run with the daemon stopped, from a spot representative of the deployment:

```sh
send 'AT+CGPS=0' 3; sleep 3
send 'AT+CGPSDEL' 3          # wipe aiding (XTRA file survives)
send 'AT+CGPS=1,1' 2
# poll AT+CGPSINFO every 1-2 s; TTFF = time until lat/lon appear
```

Baselines from the reference device (bench, partial sky):

| Scenario | TTFF |
| --- | --- |
| Assisted cold start (aiding wiped, XTRA valid, 27-30 sats in view) | ~90 s |
| Warm/hot start (aiding retained — the normal power-on case) | seconds to ~30 s |
| Unassisted cold start, constrained sky (the old configuration) | 3-15+ min, sometimes never |

When comparing antenna options, watch `gps.satellites_in_view` and GSV C/N0
values rather than TTFF alone — in-view count is the antenna/sky-view signal,
TTFF also depends on assistance state.

## Telemetry interpretation

- `gps.satellites_in_view` (GSV) high but `gps.satellites` (used, GGA) low →
  seeing plenty of sky, solution still converging or heavy multipath.
- `satellites_in_view` low (< ~8) → sky view or antenna problem; software
  cannot fix this.
- `gps.hdop`: < 2 good, 2-5 usable, > 5 treat the position with suspicion
  (urban multipath can put a "fix" tens of meters off).
- Published lat/lon are always **current**: the agent clears position + hdop
  on lock loss instead of freezing the last-known point. `fix_quality: 0`
  with no lat/lon = acquiring.
- `xtra_valid_min` (modem telemetry JSON, not the MQTT payload): should sit
  between ~8600 and 10080; 0/null means assistance is missing and cold starts
  will be slow — check the daemon log for `XTRA download failed`.

## Antenna (the remaining hardware lever)

Facts that constrain the choice:

- **Where bias comes from depends on the module form factor.** The bare
  SIM7600 LGA pad supplies no DC bias (bias tee must live on the carrier —
  Waveshare's non-M.2 HAT hardwires 3.3 V via 10 Ω + 47 nH). On the
  **SIM7600G-H-M.2 card (the Argus board's form factor)** the RF connectors
  are on the card itself and the bias tee is on-card, fed from the module's
  VDD_AUX LDO and switched by `AT+CVAUXS` — Waveshare's FAQ for this exact
  card: "you can use `AT+CVAUXS=1` to power the antenna, allowing it to work
  with an active antenna". `SIM7600_GNSS_ANT_BIAS=1` makes the daemon do
  this properly ordered: `AT+CVAUXV=3050` (max) **then** `AT+CVAUXS=1`.
  Order matters: our unit's LDO register sat at the 1700 mV minimum, so
  enabling before raising the voltage would brown-out most LNAs. Definitive
  check: multimeter DC on the GNSS MHF4 center pin, toggling `AT+CVAUXS`
  (expect ~0 V vs the CVAUXV setting).
- **The M.2 card's RF connectors are MHF4** (Murata MM4829-2702B class),
  not the larger u.FL/MHF1 — buy the MHF4 variant of any embedded antenna,
  or an MHF4-to-SMA bulkhead pigtail for external SMA antennas.
- Bias budget: VDD_AUX is 1.7-3.05 V (`AT+CVAUXV`, 50 mV steps), ~150 mA.
  Pick an active antenna whose LNA runs at ≤3.0 V (the Taoglas picks below
  all spec 1.8-5.5 V); avoid parts that need 3.3-5 V minimum.
- SIMCom's M.2 hardware design recommends a **passive** antenna when LTE
  B13/B14 are in use (active-antenna harmonics can degrade GNSS). Those are
  mainly US Verizon bands; on Canadian carriers this is unlikely to bind,
  and a SAW-in-front-of-LNA active antenna mitigates exactly this.
- The module is L1-band only (1559-1610 MHz). Multiband L1+L5 antennas are
  wasted money; GPS-only 1575 MHz SAW-filtered parts waste the GLONASS/BDS
  constellations.
- Keep the GNSS patch sky-facing at the top of the enclosure, LTE antenna at
  the opposite end (≥ 50-100 mm; Quectel's design note asks ≥ 10 dB isolation
  to an active GNSS antenna), coax runs not parallel. Prefer antennas with a
  SAW filter in front of the LNA so LTE TX bursts can't saturate it.

Shortlist (as of 2026-07, MHF4-compatible for the M.2 card — note that the
common Taoglas/Molex u.FL actives do NOT exist in MHF4 variants):

| Option | Part | Notes |
| --- | --- | --- |
| External, best urban | Taoglas AA.162.301111 "Ulysses" (~$26, DigiKey) + TE/Linx CSJ-SGFB-100-MHF4 pigtail (~$6, DigiKey) | Mag-mount SMA, IP67, 28 dB LNA at 3 V (1.8-5.5 V, 10 mA), SAW front end, GPS+GLO+GAL+BDS B1, 3 m RG174. Pigtail = MHF4 plug to SMA(F) bulkhead, 100 mm. |
| Embedded, direct plug | 2J Antennas 2JM3201C5F, MHF4L variant (~$15-20, Techship) | Active 25×25×12 mm stacked patch, SAW pre-filter, 28 dB LNA (1.5-6 V, 16 mA @ 3 V), full L1 GNSS band. Only distributor-stocked brand-name MHF4-family active GNSS antenna found. Confirm MHF4L↔MHF4 mating with Techship. |
| Embedded, passive fallback | 2J 2JF0201P flex, MHF4L (Techship) | Passive full-GNSS flex; no bias needed, but expect reduced sensitivity in an enclosure — last resort. |

Pigtail alternates: Taoglas CAB.01055 (150 mm, MHF4 to SMA-F bulkhead).
The stock passive FPC combo antenna is the floor: no LNA, no ground plane
control, LTE radiator centimeters away. Any option above is an upgrade.

### Enabling antenna bias on a device (`SIM7600_GNSS_ANT_BIAS`)

Order of operations matters — **swap the antenna first, then enable bias**.
A passive antenna can present a DC short across the coax; 3.05 V into a short
through the card's small bias resistor can exceed the VDD_AUX LDO's ~150 mA
budget. Same in reverse: disable bias before going back to a passive antenna.

1. Physically connect the active antenna to the M.2 card's GNSS MHF4.
2. Set the env var via a systemd drop-in (survives `xorgate update`, which
   overwrites the unit file itself but leaves drop-ins alone):

   ```sh
   sudo mkdir -p /etc/systemd/system/sim7600-lte.service.d
   sudo tee /etc/systemd/system/sim7600-lte.service.d/override.conf >/dev/null <<'EOF'
   [Service]
   Environment="SIM7600_GNSS_ANT_BIAS=1"
   EOF
   sudo systemctl daemon-reload
   sudo systemctl restart sim7600-lte
   ```

   On restart the daemon sends `AT+CVAUXV=3050` then `AT+CVAUXS=1` (that
   order — the LDO register can sit at the 1700 mV minimum, and enabling
   before raising the voltage browns out most LNAs).
3. Verify. Cheapest check is the journal plus the in-view count:

   ```sh
   journalctl -u sim7600-lte -n 50 | grep -i bias   # "Enabling GNSS active-antenna bias"
   xorgate manage                                    # GPS pane: sats in view should jump vs the old antenna
   ```

   Definitive check (daemon stopped): read back the LDO state on the AT port —
   `AT+CVAUXS?` → `+CVAUXS: 1`, `AT+CVAUXV?` → `+CVAUXV: 3050` — or put a
   multimeter on the GNSS MHF4 center pin (expect ~3.05 V vs ~0 V with
   `AT+CVAUXS=0`).
4. To disable (before refitting a passive antenna): delete the drop-in, then
   `sudo systemctl daemon-reload && sudo systemctl restart sim7600-lte`, and
   since the LDO setting persists in the modem, also send `AT+CVAUXS=0` once
   (daemon stopped), or power-cycle the modem.

To make it fleet-default instead of per-device, flip the default in
`modem/sim7600-lte.sh` (`SIM7600_GNSS_ANT_BIAS:-0` → `:-1`) and roll out via
the normal tarball — but only once every deployed unit has an active antenna
fitted, because of the passive-short caveat above.
