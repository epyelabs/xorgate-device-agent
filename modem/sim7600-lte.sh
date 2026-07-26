#!/bin/bash
# =============================================================================
# sim7600-lte.sh — Resilient LTE connection manager for SIM7600G-H-M.2
# =============================================================================
# Designed for IoT deployments (e.g. xorgate edge device, fleet tracking).
#
# Features:
#   - Waits for stable signal (AT+CSQ) before connecting
#   - Configures + enables GNSS so NMEA streams on the dedicated GPS port:
#       * all constellations (AT+CGNSSMODE), DPO off for max sensitivity
#       * XTRA predicted-ephemeris assistance (AT+CGPSXE/AT+CGPSXD) with
#         periodic re-download — the big TTFF win in urban canyons
#       * SUPL UE-based AGPS (AT+CGPSURL + AT+CGPS=1,2), auto-falls back to
#         standalone when the server is unreachable
#   - Re-asserts the GNSS engine while connected (survives modem resets)
#   - Adaptive CSQ polling: faster when signal is changing rapidly
#   - Signal-aware reconnect: distinguishes dead zone vs network failure
#   - Registration-aware: good RSSI alone never triggers a connect attempt;
#     the modem must also be attached to the network (AT+CEREG)
#   - Escalating recovery ladder for failures a plain retry can't fix:
#     PS re-attach (AT+CGATT/AT+COPS) -> radio cycle (AT+CFUN) -> full modem
#     reset (AT+CRESET, the same cure a host reboot provides)
#   - Wedge detection in dead-zone wait: no service for too long nudges the
#     radio, then resets the modem (firmware can stop cell-searching after a
#     prolonged outage)
#   - Atomic JSON telemetry output for consumption by other processes
#   - Automatic reconnect on link failure
#
# NOTE (RNDIS mode, USB PID 9011): the LTE data call is dialed by the modem
# firmware itself; usb0's DHCP lease comes from the modem's INTERNAL NAT
# (192.168.225.1), so a successful dhclient bind proves nothing about the WAN.
# Connectivity must be verified end-to-end (ping) and recovery must happen at
# the modem level — AT+NETOPEN/NETCLOSE only drive the internal socket stack.
# usb0 must NOT be managed by NetworkManager (see 99-sim7600-unmanaged.conf).
#
# The xorgate-device-agent reads two things this daemon produces:
#   - LTE signal: the telemetry JSON at TELEMETRY_FILE (lte collector)
#   - GPS: NMEA on /dev/ttyUSB1, enabled here via AT+CGPS (gps collector)
# This daemon OWNS the AT port; the agent never opens it.
# =============================================================================

# --- Configuration -----------------------------------------------------------
SERIAL="${SIM7600_SERIAL:-/dev/ttyUSB2}"
IFACE="${SIM7600_IFACE:-usb0}"
PING_HOST="${SIM7600_PING_HOST:-8.8.8.8}"

# Signal thresholds (AT+CSQ returns RSSI 0–31; 99 = unknown)
# 10 = ~-93dBm (marginal), 15 = ~-83dBm (good)
MIN_CSQ="${SIM7600_MIN_CSQ:-10}"
GOOD_CSQ="${SIM7600_GOOD_CSQ:-15}"

# Timing (seconds)
SIGNAL_STABLE_COUNT=3        # consecutive good readings before connecting
HEALTH_CHECK_INTERVAL=15     # how often to ping while connected
HEALTH_FAIL_THRESHOLD=3      # consecutive ping failures before reconnect
RECONNECT_DELAY=5            # base wait before attempting reconnect (backs off)
AT_CMD_DELAY=1               # pause between AT commands
MODEM_BOOT_WAIT=8            # initial wait for modem USB enumeration
# Config-read retries (at_setting_confirmed): AT reads of persisted settings
# intermittently return nothing at daemon start even on a healthy modem (the
# F7 flake). A lost read must never be mistaken for config drift.
AT_SETTING_ATTEMPTS=3        # read attempts before giving up ("unknown")
AT_SETTING_RETRY_DELAY=1     # pause between attempts
# For ~10 s after a modem (re)boot, GNSS config queries answer well-formed
# boot-DEFAULT values before NV state is loaded (measured 3/3 reboots:
# +CGPSXE reads 0 until ~11 s post-enumeration, then the true 1) — landing
# exactly where the daemon's startup reads fall. Apparent drift must
# therefore hold across a re-read this far apart before it may be repaired.
DRIFT_CONFIRM_DELAY=15       # secs between the two reads that confirm drift
# GNSS engine start sequencing (F4, verified on-device 2026-07-25): the
# SUPL-assisted start AT+CGPS=1,2 is rejected ("explicit mode not accepted")
# when issued too soon after AT+CGPS=0 or a modem reboot; the same command is
# accepted after a ~4-5 s settle. Sequencing bug, not a firmware limitation.
GNSS_START_SETTLE_SECS=5     # min settle before an explicit-mode engine start
# Post-reset quiet period (F10/F11): for ~10 s after re-enumeration the modem
# answers config queries with well-formed boot DEFAULTS (NV not yet loaded)
# and auto-restarts the GNSS engine itself as plain "1,1". Post-reset recovery
# must sit out this window before trusting or touching GNSS state.
GNSS_RESET_SETTLE_SECS=15    # wait after modem reboot before GNSS recovery acts

# Recovery ladder / wedge detection (seconds unless noted)
# After consecutive failed connect cycles the ladder escalates:
#   fail 1: plain retry, fail 2: PS re-attach, fail 3: radio cycle,
#   fail 4: modem reset (AT+CRESET) — then the ladder repeats.
DEADZONE_NUDGE_SECS="${SIM7600_DEADZONE_NUDGE_SECS:-600}"  # no service this long -> nudge radio
RECONNECT_DELAY_MAX=60       # cap for backed-off reconnect delay
# Power-aware cooldowns: a radio cycle and especially a modem reset force a
# full re-registration, during which the SIM7600 pulls TX bursts up to ~2A.
# On a marginal vehicle supply, clustering those events risks browning out the
# host. These floors bound how often each rung may fire; on cooldown the rung
# is skipped (logged) and the cheaper retries continue.
RADIO_CYCLE_COOLDOWN="${SIM7600_RADIO_CYCLE_COOLDOWN:-300}"   # min secs between AT+CFUN cycles
MODEM_RESET_COOLDOWN="${SIM7600_MODEM_RESET_COOLDOWN:-1800}"  # min secs between AT+CRESET

# Default-route metric for the LTE uplink. Must stay ABOVE the WiFi metric
# (50, see 10-uplink-priority.conf) so WiFi wins while associated; dhclient
# alone would install metric 0 and silently steal the whole uplink.
LTE_ROUTE_METRIC="${SIM7600_ROUTE_METRIC:-100}"

# Adaptive CSQ polling intervals (seconds)
CSQ_INTERVAL_FAST=3          # signal changing rapidly (delta >= CSQ_RAPID_DELTA)
CSQ_INTERVAL_WEAK=5          # signal weak / recovering (CSQ < MIN_CSQ)
CSQ_INTERVAL_STABLE=30       # signal stable and connected
CSQ_RAPID_DELTA=3            # CSQ change threshold to trigger fast polling

# Modem temperature poll (AT+CPMUTEMP) — temperature moves slowly, so this
# rides its own fixed interval instead of the adaptive CSQ cadence.
MODEM_TEMP_INTERVAL="${SIM7600_MODEM_TEMP_INTERVAL:-30}"

# GPS / GNSS
ENABLE_GPS="${SIM7600_ENABLE_GPS:-1}"   # set 0 to skip enabling GNSS
# Constellations on top of GPS (AT+CGNSSMODE bitmask): 1 GLONASS, 2 BeiDou,
# 4 Galileo, 8 QZSS. 15 = everything; more satellites = better geometry when
# only a slot of sky is visible (urban canyon). Needs LE20-era firmware.
GNSS_MODE="${SIM7600_GNSS_MODE:-15}"
GNSS_DPO="${SIM7600_GNSS_DPO:-0}"       # DPO duty-cycling: 0 = off (max sensitivity)
GNSS_XTRA="${SIM7600_GNSS_XTRA:-1}"     # XTRA predicted-ephemeris assistance
# SUPL server for UE-based AGPS (AT+CGPS=1,2). Empty = plain standalone start.
# Port 7276 = plain TCP; 7275 would need a carrier TLS cert (AT+CGPSSSL=1).
SUPL_URL="${SIM7600_SUPL_URL:-supl.google.com:7276}"
# Horizontal accuracy threshold in meters (AT+CGPSHOR, factory default 50).
# Looser lets the engine report an early coarse fix in bad geometry; it then
# refines. For a tracker an early rough position beats a late precise one.
GNSS_ACCURACY="${SIM7600_GNSS_ACCURACY:-100}"
# NMEA sentence bitmask (AT+CGPSNMEA). 197119 = GGA+RMC+GSV+GSA+VTG+ the
# GLONASS/Galileo/BeiDou GSA/GSV variants — the agent parses GSA (HDOP) and
# GSV (satellites in view) for fix confidence.
NMEA_MASK="${SIM7600_NMEA_MASK:-197119}"
# Aux LDO powering an ACTIVE GNSS antenna's LNA (AT+CVAUXS/AT+CVAUXV). Driven
# by `gnssAntBias` in the agent's settings.json (set from the web device
# settings page or `xorgate set gps-antenna`); missing/unreadable file or key
# means passive (bias off), the hardware-safe default. Asserted at boot and
# re-checked live in the health loop — no daemon restart needed to change it.
# The env var only relocates the file for dev setups; it is not a value
# override. 3050 mV is the LDO maximum (hardcoded; set BEFORE output on).
SETTINGS_FILE="${SIM7600_SETTINGS_FILE:-/var/lib/xorgate/settings.json}"
GNSS_ANT_BIAS_MV=3050
GNSS_BIAS_CHECK_INTERVAL=30          # settings.json re-read cadence (seconds)
# XTRA maintenance: re-download when validity drops under a day (file is good
# for ~7 days; SIMCom suggests daily refresh), checking every 6 h while up.
XTRA_MIN_VALID_MIN=1440
XTRA_CHECK_INTERVAL=21600
XTRA_RETRY_DELAY=600                 # re-attempt sooner after a failed download
HTP_HOST="${SIM7600_HTP_HOST:-www.google.com}"  # HTP time source (XTRA needs accurate clock)
GNSS_REASSERT_INTERVAL=600           # re-check the engine every 10 min while connected

# Telemetry
TELEMETRY_FILE="${SIM7600_TELEMETRY_FILE:-/run/sim7600-lte/telemetry.json}"

# --- Logging -----------------------------------------------------------------
LOG_TAG="sim7600-lte"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO]  $*" | tee -a /var/log/sim7600-lte.log; logger -t "$LOG_TAG" "$*"; }
warn() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN]  $*" | tee -a /var/log/sim7600-lte.log; logger -t "$LOG_TAG" -p user.warning "$*"; }
err()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*" | tee -a /var/log/sim7600-lte.log; logger -t "$LOG_TAG" -p user.err "$*"; }

# --- Telemetry ---------------------------------------------------------------
# Writes an atomic JSON snapshot to TELEMETRY_FILE.
# Other processes (GPS, IMU, cloud uploader) can read this at any time
# without risk of reading a half-written file.
#
# Schema:
# {
#   "timestamp":    ISO-8601 UTC string
#   "csq":          integer 0-31, or 99 if unknown
#   "rssi_dbm":     integer dBm, or null if unknown
#   "csq_interval": current adaptive poll interval in seconds
#   "status":       "connected" | "connecting" | "disconnected" | "dead_zone"
#   "reg":          last seen registration <stat> (1 home, 5 roaming, 2
#                   searching, 3 denied, 0 none, 99 unknown)
#   "iface":        interface name
#   "ip":           current IP string, or null
#   "xtra_valid_min": minutes of GNSS XTRA assistance validity left, or null
#   "gnss_ant_bias": 0|1 last-applied antenna bias state, or null before first apply
#   "modem_temp":   modem PMU temperature in °C (AT+CPMUTEMP), or null if
#                   never read / unsupported by this firmware
# }
write_telemetry() {
    local csq="$1"
    local status="$2"
    local csq_interval="$3"

    mkdir -p "$(dirname "$TELEMETRY_FILE")"

    local rssi_dbm="null"
    if [[ "$csq" -ne 99 ]]; then
        rssi_dbm=$(( -113 + csq * 2 ))
    fi

    local ip="null"
    local raw_ip
    # Take only the first inet address: an interface can carry several (the modem
    # may hand out more than one), and embedding a multi-line value would produce
    # invalid JSON (a raw newline inside a JSON string). head -n1 keeps it valid.
    raw_ip=$(ip addr show "$IFACE" 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 | head -n1)
    if [[ -n "$raw_ip" ]]; then
        ip="\"$raw_ip\""
    fi

    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    # Write to temp file first, then atomically move into place
    # so readers never see a partial file
    local tmp="${TELEMETRY_FILE}.tmp"

    cat > "$tmp" <<EOF
{
  "timestamp": "$timestamp",
  "csq": $csq,
  "rssi_dbm": $rssi_dbm,
  "csq_interval": $csq_interval,
  "status": "$status",
  "reg": ${LAST_REG:-99},
  "iface": "$IFACE",
  "ip": $ip,
  "xtra_valid_min": ${XTRA_VALID_MIN:-null},
  "gnss_ant_bias": ${GNSS_BIAS_APPLIED:-null},
  "modem_temp": ${MODEM_TEMP:-null}
}
EOF

    mv "$tmp" "$TELEMETRY_FILE"
}

# --- AT command helpers -------------------------------------------------------
# CRITICAL: every open of $SERIAL must be guarded by [[ -c ]]. When the modem
# drops off USB (AT+CRESET, power blip) the device node vanishes, and a bare
# `>` or `<>` redirect would CREATE A REGULAR FILE at that path — which then
# blocks the kernel from recreating the real node on re-enumeration. That
# wedges the AT port until someone deletes the file (i.e. "until a reboot").
at_cmd() {
    local cmd="$1"
    local wait="${2:-$AT_CMD_DELAY}"
    [[ -c "$SERIAL" ]] || return 1
    echo -e "${cmd}\r" > "$SERIAL"
    sleep "$wait"
}

# Send a command and return its full response. Opens the port on an fd, drains
# any stale bytes first (leftover URCs / echoes from fire-and-forget at_cmd),
# then reads line-by-line until the final result code or timeout. This avoids
# the write-then-open-reader race of the old `echo; timeout cat` approach,
# which routinely lost responses and produced spurious CSQ=99 readings.
at_query() {
    local cmd="$1" secs="${2:-4}" line resp=""
    [[ -c "$SERIAL" ]] || return 1
    exec 3<>"$SERIAL" 2>/dev/null || return 1
    while IFS= read -r -t 0.1 -u 3 line; do :; done
    printf '%s\r' "$cmd" >&3
    local deadline=$(( SECONDS + secs ))
    while (( SECONDS < deadline )); do
        if IFS= read -r -t 1 -u 3 line; then
            line="${line%$'\r'}"
            [[ -z "$line" ]] && continue
            resp+="$line"$'\n'
            case "$line" in
                OK|ERROR|*"+CME ERROR"*|*"+CMS ERROR"*|*"+IP ERROR"*) break ;;
            esac
        fi
    done
    exec 3<&- 3>&-
    printf '%s' "$resp"
}

# Send a command and wait (up to $2 seconds) for a line matching $3 — for
# commands that answer with a delayed URC (XTRA download, HTP time sync).
# grep -m1 returns as soon as the URC lands, so the happy path doesn't burn
# the full timeout. Prints the matched line, or nothing on timeout.
at_wait_urc() {
    local cmd="$1" secs="$2" pattern="$3"
    [[ -c "$SERIAL" ]] || return 1
    echo -e "${cmd}\r" > "$SERIAL"
    timeout "$secs" grep -m1 -aE "$pattern" "$SERIAL" 2>/dev/null | tr -d '\r'
}

# --- Signal quality ----------------------------------------------------------
get_csq() {
    # One retry on 99/empty: a lost AT response must not masquerade as a dead
    # zone — that misclassification drives the wrong reconnect path.
    local raw val attempt
    for attempt in 1 2; do
        raw=$(at_query "AT+CSQ" | grep "+CSQ:" | head -1)
        val=$(echo "$raw" | sed -n 's/.*+CSQ: \([0-9]*\),.*/\1/p')
        if [[ -n "$val" && "$val" -ne 99 ]]; then
            echo "$val"
            return
        fi
        sleep 1
    done
    echo "${val:-99}"
}

# --- Network registration -----------------------------------------------------
# CS/PS registration status from AT+CEREG (LTE), falling back to AT+CGREG.
# Prints the <stat> digit: 1 home, 5 roaming, 2 searching, 3 denied, 0 none,
# 99 unknown/no-response. Good RSSI without registration is exactly the state
# a long outage leaves behind — it must never be treated as "ready to connect".
LAST_REG=99
# Updates LAST_REG in the CURRENT shell (no command substitution — a subshell
# would throw the value away and telemetry/logs would show a stale 99).
update_reg() {
    local stat
    stat=$(at_query "AT+CEREG?" | sed -n 's/.*+CEREG: [0-9],\([0-9]\).*/\1/p' | head -1)
    if [[ -z "$stat" ]]; then
        stat=$(at_query "AT+CGREG?" | sed -n 's/.*+CGREG: [0-9],\([0-9]\).*/\1/p' | head -1)
    fi
    LAST_REG="${stat:-99}"
}

is_registered() {
    update_reg
    [[ "$LAST_REG" == "1" || "$LAST_REG" == "5" ]]
}

# True when PDP context 1 holds a real WAN address (the RNDIS data call is up
# modem-side). dhclient success can NOT stand in for this — the lease comes
# from the modem's internal NAT and is granted even with the WAN dead.
wan_ip_up() {
    local addr
    addr=$(at_query "AT+CGPADDR=1" | sed -n 's/.*+CGPADDR: 1,"\{0,1\}\([0-9.]*\).*/\1/p' | head -1)
    [[ -n "$addr" && "$addr" != "0.0.0.0" ]]
}

csq_to_dbm() {
    local csq="$1"
    if [[ "$csq" -eq 99 ]]; then echo "unknown"; return; fi
    echo "$(( -113 + csq * 2 )) dBm"
}

# Computes adaptive poll interval based on signal state and rate of change.
# Args: $1=current_csq $2=previous_csq
# Prints interval in seconds.
adaptive_interval() {
    local csq="$1"
    local prev_csq="$2"

    if [[ "$csq" -eq 99 || "$csq" -lt "$MIN_CSQ" ]]; then
        # Weak or unknown — poll more often, reconnect decisions depend on this
        echo "$CSQ_INTERVAL_WEAK"
        return
    fi

    local delta=$(( csq - prev_csq ))
    delta="${delta#-}"   # absolute value

    if [[ "$delta" -ge "$CSQ_RAPID_DELTA" ]]; then
        # Signal changing rapidly — increase resolution
        echo "$CSQ_INTERVAL_FAST"
    else
        # Signal stable — back off to conserve AT bus bandwidth
        echo "$CSQ_INTERVAL_STABLE"
    fi
}

# --- Modem temperature --------------------------------------------------------
# PMU temperature via AT+CPMUTEMP, published in telemetry as "modem_temp".
# Empty until the first successful read; an ERROR/empty response leaves the
# last good value in place (a lost AT response is not a temperature change).
MODEM_TEMP=""
MODEM_TEMP_AT=-9999   # negative so the first maybe_update fires immediately

get_modem_temp() {
    # Updates MODEM_TEMP in the CURRENT shell (same subshell pitfall update_reg
    # documents — command substitution would discard the value).
    local val
    val=$(at_query "AT+CPMUTEMP" | sed -n 's/.*+CPMUTEMP:[[:space:]]*\(-\{0,1\}[0-9]\{1,\}\).*/\1/p' | head -1)
    if [[ -n "$val" ]]; then
        MODEM_TEMP="$val"
    fi
}

# Self-throttled wrapper — call next to get_csq in the poll loops; the daemon
# is single-threaded and sole owner of the AT port, so sequencing is safe.
maybe_update_modem_temp() {
    (( SECONDS - MODEM_TEMP_AT >= MODEM_TEMP_INTERVAL )) || return 0
    MODEM_TEMP_AT=$SECONDS
    get_modem_temp
}

# --- GPS / GNSS --------------------------------------------------------------
# The GNSS engine streams NMEA on the dedicated GPS port (/dev/ttyUSB1), where
# the agent's gps collector reads it; everything here talks only to the AT port
# so there is no contention with that stream.
#
# TTFF strategy (why this is more than the old one-shot AT+CGPS=1):
#   - A bare standalone start must demodulate ephemeris from the satellites at
#     50 bit/s, which needs ~-144 dBm — exactly what an urban canyon denies.
#   - XTRA sideloads predicted ephemeris over LTE instead (valid ~7 days,
#     survives reboots in module flash), so the engine only needs to *track*
#     satellites, not decode them. Requires an accurate module clock, hence
#     the HTP time sync before every download.
#   - SUPL UE-based AGPS (AT+CGPS=1,2) adds server-computed assistance when
#     the data link is up, and the modem auto-falls back to standalone.

# Minutes of XTRA validity left (telemetry), and maintenance timestamps.
XTRA_VALID_MIN=null
LAST_XTRA_CHECK=0
LAST_GNSS_CHECK=0
# Last-applied antenna bias (0/1; empty until configure_gnss asserts it).
GNSS_BIAS_APPLIED=""
LAST_BIAS_CHECK=0

# Desired antenna bias from the agent's settings.json: prints 1 (active) or 0
# (passive). Any failure — missing/unreadable file, bad JSON, missing key, no
# python3 — resolves to 0, the hardware-safe default (jq is not guaranteed on
# the device; python3 is).
gnss_bias_desired() {
    local out
    out=$(python3 - "$SETTINGS_FILE" 2>/dev/null <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        v = json.load(f).get("gnssAntBias")
    print("1" if v is True else "0")
except Exception:
    print("0")
PYEOF
    )
    if [[ "$out" == "1" ]]; then echo 1; else echo 0; fi
}

# Assert the antenna bias state on the modem (both directions). Safe to apply
# live — it never touches the GNSS engine or the LTE link.
gnss_bias_apply() {
    local desired="$1"
    if [[ "$desired" == "1" ]]; then
        # Order matters: program the LDO voltage BEFORE switching the output
        # on — the register can sit at 1700 mV, which browns out most LNAs.
        log "GNSS antenna bias -> on (AT+CVAUXV=$GNSS_ANT_BIAS_MV then AT+CVAUXS=1) (source: settings)"
        at_cmd "AT+CVAUXV=$GNSS_ANT_BIAS_MV" 1
        at_cmd "AT+CVAUXS=1" 1
    else
        log "GNSS antenna bias -> off (AT+CVAUXS=0) (source: settings)"
        at_cmd "AT+CVAUXS=0" 1
    fi
    GNSS_BIAS_APPLIED="$desired"
}

# Live re-apply: re-read settings.json (self-throttled) and only touch the AT
# port when the desired state differs from what was last applied.
gnss_bias_maintain() {
    [[ "$ENABLE_GPS" == "1" ]] || return 0
    local now
    now=$(date +%s)
    (( now - LAST_BIAS_CHECK < GNSS_BIAS_CHECK_INTERVAL )) && return 0
    LAST_BIAS_CHECK=$now
    local desired
    desired=$(gnss_bias_desired)
    if [[ "$desired" != "$GNSS_BIAS_APPLIED" ]]; then
        gnss_bias_apply "$desired"
    fi
}

gps_engine_on() {
    local state
    state=$(at_query "AT+CGPS?" | sed -n 's/.*+CGPS: \([01]\).*/\1/p')
    [[ "$state" == "1" ]]
}

gps_stop() {
    if gps_engine_on; then
        log "Stopping GNSS engine for reconfiguration (AT+CGPS=0)..."
        at_cmd "AT+CGPS=0" 3
    fi
}

# Start the GNSS engine, SUPL-assisted when a SUPL server is configured.
# Callers reach here only with the engine off ("found off" or post-reset via
# gnss_recover_after_reset) — never to re-start a running engine (F5 non-goal).
# F5: mode 2 is non-sticky — when the SUPL session fails the engine
# auto-reverts and AT+CGPS? later reads 1,1. That is the documented fallback,
# NOT a failed start; nothing may flap the engine to force mode 2 back
# (gnss_reassert's "any 1,x = on" check depends on this).
gps_start() {
    if gps_engine_on; then
        return
    fi
    local mode="1,2" desc="UE-based AGPS (SUPL; auto-falls back to standalone)"
    if [[ -z "$SUPL_URL" ]]; then
        mode="1,1" desc="standalone"
    fi
    # F4: the explicit-mode start is rejected when it lands too close to the
    # last AT+CGPS=0 / modem reboot; this settle is what turns the historical
    # "not accepted" fallback into a first-try acceptance.
    sleep "$GNSS_START_SETTLE_SECS"
    log "Starting GNSS engine in $desc mode (AT+CGPS=$mode)..."
    local resp
    resp=$(at_query "AT+CGPS=$mode" 6)
    if ! grep -q "OK" <<< "$resp"; then
        warn "AT+CGPS=$mode not accepted — retrying once after another ${GNSS_START_SETTLE_SECS}s settle."
        sleep "$GNSS_START_SETTLE_SECS"
        resp=$(at_query "AT+CGPS=$mode" 6)
    fi
    if grep -q "OK" <<< "$resp"; then
        return 0
    fi
    warn "GNSS explicit-mode start failed twice — falling back to plain AT+CGPS=1 (running standalone: SUPL assist unavailable this session)."
    at_cmd "AT+CGPS=1" 2
}

# Read a "+PREFIX: value" style current setting; prints the raw value part.
at_setting() {
    local cmd="$1" prefix="$2"
    at_query "$cmd" | sed -n "s/.*+${prefix}: *//p" | head -1
}

# Confirmed read of a "+PREFIX: value" setting, for decisions that must not
# act on a lost response. Retries up to AT_SETTING_ATTEMPTS times and prints
# the value as soon as a response line carrying the expected prefix arrives.
# The value may legitimately be empty-looking (an unset AT+CGPSURL answers
# +CGPSURL: "") — presence of the prefix line, not the value, is what marks
# the read confirmed, so callers must branch on the return code, not on -z.
# Returns: 0 = confirmed read (output is authoritative), 2 = firmware
# rejected the command (ERROR seen, no value on any attempt), 1 = no usable
# response at all — the setting is UNKNOWN and must be left alone.
at_setting_confirmed() {
    local cmd="$1" prefix="$2" attempt raw saw_error=0
    for (( attempt = 1; attempt <= AT_SETTING_ATTEMPTS; attempt++ )); do
        (( attempt > 1 )) && sleep "$AT_SETTING_RETRY_DELAY"
        raw=$(at_query "$cmd")
        if grep -qF -- "+${prefix}:" <<< "$raw"; then
            # F7 visibility: callers capture stdout, so log via stderr only.
            (( attempt > 1 )) && log "AT read of +${prefix} needed attempt $attempt/$AT_SETTING_ATTEMPTS (flaky AT port)." >&2
            sed -n "s/.*+${prefix}: *//p" <<< "$raw" | head -1
            return 0
        fi
        grep -q "ERROR" <<< "$raw" && saw_error=1
    done
    (( saw_error )) && return 2
    return 1
}

# Second half of the drift invariant: a confirmed read that differs from the
# target may still be a modem-boot transient (see DRIFT_CONFIRM_DELAY). Waits,
# re-reads, and returns 0 only when the same non-target value is read again —
# only then is the drift real and repair (write/reset) allowed. Logs its
# verdict; callers keep their first read's value on success.
drift_is_stable() {
    local cmd="$1" prefix="$2" first="$3" again rc
    log "Apparent GNSS config drift (+${prefix}: '$first') — re-reading in ${DRIFT_CONFIRM_DELAY}s to rule out a modem-boot transient..."
    sleep "$DRIFT_CONFIRM_DELAY"
    again=$(at_setting_confirmed "$cmd" "$prefix"); rc=$?
    again=${again//\"/}; again=${again// /}
    if (( rc != 0 )); then
        warn "+${prefix} re-read failed — drift unconfirmed, leaving as-is (no write, no reset)."
        return 1
    elif [[ "$again" != "$first" ]]; then
        log "+${prefix} settled to '$again' on re-read — boot transient, not drift; leaving as-is."
        return 1
    fi
    return 0
}

# One-time (idempotent) GNSS configuration. Compares each persisted setting
# and only writes on drift, so a normal boot makes no config writes and no
# modem reset. Settings that need the engine stopped stop it first; settings
# that only apply after a module restart set need_reset, and we AT+CRESET once
# at the end (values persist in NV) — exiting through gnss_recover_after_reset
# like every other reset path.
configure_gnss() {
    if [[ "$ENABLE_GPS" != "1" ]]; then
        log "GNSS setup skipped (SIM7600_ENABLE_GPS=$ENABLE_GPS)."
        return
    fi

    # INVARIANT: need_reset=1 (and any config write) requires CONFIRMED drift:
    # an at_setting_confirmed rc-0 read that differs from the target AND holds
    # on a drift_is_stable re-read. A failed read (rc 1/2) means UNKNOWN: warn
    # and leave the setting alone. Acting on lost reads — or on the well-formed
    # boot-default answers the modem serves for ~10 s after (re)boot — is what
    # fired spurious AT+CRESETs on healthy modems and wedged the GNSS engine
    # (the 2026-07 TTFF field regression).
    local need_reset=0 cur rc

    # Constellations + DPO (persists in NV; module restart to take effect).
    cur=$(at_setting_confirmed "AT+CGNSSMODE?" "CGNSSMODE"); rc=$?
    cur=${cur// /}
    if (( rc == 2 )); then
        warn "AT+CGNSSMODE rejected by firmware (old firmware?) — staying on firmware default constellations."
    elif (( rc != 0 )); then
        warn "AT+CGNSSMODE read failed after $AT_SETTING_ATTEMPTS attempts — constellation config unknown, leaving as-is (no write, no reset)."
    elif [[ "$cur" != "$GNSS_MODE,$GNSS_DPO" ]] && drift_is_stable "AT+CGNSSMODE?" "CGNSSMODE" "$cur"; then
        log "GNSS constellations: $cur -> $GNSS_MODE,$GNSS_DPO (AT+CGNSSMODE)."
        gps_stop
        at_cmd "AT+CGNSSMODE=$GNSS_MODE,$GNSS_DPO" 2
        need_reset=1
    fi

    # XTRA enable (module restart to take effect).
    cur=$(at_setting_confirmed "AT+CGPSXE?" "CGPSXE"); rc=$?
    cur=${cur// /}
    if (( rc != 0 )); then
        warn "AT+CGPSXE read failed after $AT_SETTING_ATTEMPTS attempts — XTRA-enable state unknown, leaving as-is (no write, no reset)."
    elif [[ "$cur" != "$GNSS_XTRA" ]] && drift_is_stable "AT+CGPSXE?" "CGPSXE" "$cur"; then
        log "GNSS XTRA: $cur -> $GNSS_XTRA (AT+CGPSXE)."
        gps_stop
        at_cmd "AT+CGPSXE=$GNSS_XTRA" 2
        need_reset=1
    fi

    # SUPL server for UE-based AGPS (module restart to take effect). A truly
    # unset URL still reads confirmed (+CGPSURL: "" -> rc 0, empty value) and
    # is repaired; only a LOST read skips.
    if [[ -n "$SUPL_URL" ]]; then
        cur=$(at_setting_confirmed "AT+CGPSURL?" "CGPSURL"); rc=$?
        cur=${cur//\"/}
        if (( rc != 0 )); then
            warn "AT+CGPSURL read failed after $AT_SETTING_ATTEMPTS attempts — SUPL server unknown, leaving as-is (no write, no reset)."
        elif [[ "$cur" != "$SUPL_URL" ]] && drift_is_stable "AT+CGPSURL?" "CGPSURL" "$cur"; then
            log "AGPS SUPL server: '${cur:-unset}' -> $SUPL_URL (AT+CGPSURL)."
            gps_stop
            at_cmd "AT+CGPSURL=\"$SUPL_URL\"" 1
            at_cmd "AT+CGPSSSL=0" 1
            need_reset=1
        fi
    fi

    # NMEA sentence mask (needs the engine stopped, no restart).
    cur=$(at_setting_confirmed "AT+CGPSNMEA?" "CGPSNMEA"); rc=$?
    cur=${cur// /}
    if (( rc != 0 )); then
        warn "AT+CGPSNMEA read failed after $AT_SETTING_ATTEMPTS attempts — NMEA mask unknown, leaving as-is (no write)."
    elif [[ "$cur" != "$NMEA_MASK" ]] && drift_is_stable "AT+CGPSNMEA?" "CGPSNMEA" "$cur"; then
        log "NMEA sentence mask: $cur -> $NMEA_MASK (AT+CGPSNMEA)."
        gps_stop
        at_cmd "AT+CGPSNMEA=$NMEA_MASK" 1
    fi

    # Horizontal accuracy threshold: plain write, idempotent.
    at_cmd "AT+CGPSHOR=$GNSS_ACCURACY" 1

    # Active-antenna LNA bias from settings.json. Asserted unconditionally in
    # BOTH directions at boot so a replaced/reflashed module always matches the
    # setting; the health loop (gnss_bias_maintain) re-applies live changes.
    gnss_bias_apply "$(gnss_bias_desired)"

    if [[ "$need_reset" -eq 1 ]]; then
        log "GNSS settings changed — resetting modem (AT+CRESET) to apply..."
        at_cmd "AT+CRESET" 2
        # The shared routine owns everything after a reset (engine start,
        # XTRA verify, bias re-assert) — nothing more to do here.
        gnss_recover_after_reset || return 1
        return 0
    fi

    # No-reset path only. XTRA auto-inject at GPS start: the command is
    # rejected with "+CME ERROR: XTRA Disabled" until CGPSXE=1 is in effect.
    if [[ "$GNSS_XTRA" == "1" ]]; then
        at_cmd "AT+CGPSXDAUTO=1" 1
    fi

    gps_start
}

# Keep XTRA assistance fresh. Call whenever the data link is up; self-throttles
# to every XTRA_CHECK_INTERVAL (retries sooner after a failure). Syncs the
# module clock over HTP first — XTRA injection silently underperforms with a
# wrong clock. The download runs over the modem's own PS data connection.
xtra_maintain() {
    [[ "$ENABLE_GPS" == "1" && "$GNSS_XTRA" == "1" ]] || return 0

    local now
    now=$(date +%s)
    (( now - LAST_XTRA_CHECK < XTRA_CHECK_INTERVAL )) && return 0
    LAST_XTRA_CHECK=$now

    local valid
    valid=$(at_setting_confirmed "AT+CGPSXTRADATA?" "CGPSXTRADATA" | cut -d, -f1 | tr -d ' ')
    if [[ -n "$valid" && "$valid" -ge "$XTRA_MIN_VALID_MIN" ]]; then
        XTRA_VALID_MIN=$valid
        log "XTRA assistance valid for ${valid} min — no download needed."
        return 0
    fi

    log "XTRA assistance stale/missing (${valid:-unknown} min) — downloading..."

    # XTRA injection needs an accurate module clock. NITZ normally provides it;
    # only fall back to HTP time sync when the clock is obviously bogus (some
    # carriers/SIMs just ERROR on CHTPUPDATE, so it can't be the primary path).
    local year
    year=$(at_setting "AT+CCLK?" "CCLK" | tr -d '"' | cut -d/ -f1)
    if [[ -z "$year" || "10#$year" -lt 24 ]]; then
        warn "Module clock looks unset (year '20${year:-??}') — trying HTP time sync..."
        at_cmd "AT+CHTPSERV=\"ADD\",\"$HTP_HOST\",80,1" 1
        at_wait_urc "AT+CHTPUPDATE" 15 '\+CHTPUPDATE:|ERROR' >/dev/null
    fi

    # Trigger the download, then trust a re-query of the stored file over the
    # URC — the +CGPSXD result can slip between two reads of the AT port.
    at_wait_urc "AT+CGPSXD=0" 60 '\+CGPSXD:' >/dev/null
    valid=$(at_setting_confirmed "AT+CGPSXTRADATA?" "CGPSXTRADATA" | cut -d, -f1 | tr -d ' ')
    if [[ -n "$valid" && "$valid" -ge "$XTRA_MIN_VALID_MIN" ]]; then
        XTRA_VALID_MIN=$valid
        log "XTRA assistance downloaded OK (valid ${valid} min)."
    else
        warn "XTRA download failed (validity ${valid:-unknown} min); will retry in ${XTRA_RETRY_DELAY}s."
        LAST_XTRA_CHECK=$(( now - XTRA_CHECK_INTERVAL + XTRA_RETRY_DELAY ))
    fi
}

# Cheap engine liveness re-assert (modem may reset underneath us and come back
# with GNSS off since AT+CGPSAUTO=0). Self-throttles to GNSS_REASSERT_INTERVAL.
gnss_reassert() {
    [[ "$ENABLE_GPS" == "1" ]] || return 0
    local now
    now=$(date +%s)
    (( now - LAST_GNSS_CHECK < GNSS_REASSERT_INTERVAL )) && return 0
    LAST_GNSS_CHECK=$now
    if ! gps_engine_on; then
        warn "GNSS engine found off (modem reset?) — restarting it."
        gps_start
        # An engine found off usually means the modem reset underneath us, which
        # also reverts AT+CVAUXS (antenna bias) to off while our last-applied
        # tracker still says on. Clear the tracker + throttle so the very next
        # gnss_bias_maintain tick re-asserts the bias from settings.json.
        GNSS_BIAS_APPLIED=""
        LAST_BIAS_CHECK=0
    fi
}

# --- Modem / interface helpers -----------------------------------------------
wait_for_serial() {
    log "Waiting for modem serial port $SERIAL..."
    local attempts=0
    while [[ ! -c "$SERIAL" ]]; do
        # A REGULAR file at the serial path (left by an unguarded write while
        # the modem was off USB) blocks the kernel from recreating the real
        # node — delete it or the AT port never comes back without a reboot.
        if [[ -e "$SERIAL" ]]; then
            warn "$SERIAL exists but is not a character device — removing impostor file."
            rm -f "$SERIAL"
        fi
        sleep 2
        (( attempts++ ))
        if (( attempts > 30 )); then
            err "Serial port $SERIAL never appeared. Is the modem enumerated?"
            return 1
        fi
    done
    # Best-effort sane line discipline (raw, no echo) — a freshly enumerated
    # tty comes up with defaults that can mangle AT responses.
    stty -F "$SERIAL" 115200 raw -echo 2>/dev/null || true
    log "Serial port $SERIAL is available."
}

modem_at_ok() {
    local response
    response=$(at_query "AT")
    echo "$response" | grep -q "OK"
}

wait_for_modem_ready() {
    log "Waiting for modem AT interface to respond..."
    local attempts=0
    while ! modem_at_ok; do
        sleep 2
        (( attempts++ ))
        if (( attempts > 20 )); then
            err "Modem not responding to AT commands."
            return 1
        fi
    done
    log "Modem is responsive."
}

# After AT+CRESET the modem takes a few seconds to actually drop off USB.
# Checking for the serial port too early sees the OLD node still present and
# then races the disappearance — so first wait for the port to GO AWAY (up to
# 30s; if it never does, proceed anyway), then wait for it to come back.
wait_for_modem_reboot() {
    local waited=0
    while [[ -c "$SERIAL" ]] && (( waited < 30 )); do
        sleep 1
        (( waited++ ))
    done
    if [[ ! -c "$SERIAL" ]]; then
        log "Modem dropped off USB (expected after reset)."
    else
        warn "Modem never left the USB bus after reset; continuing anyway."
    fi
    wait_for_serial || return 1
    wait_for_modem_ready || return 1
}

# --- Unified post-reset GNSS recovery ----------------------------------------
# The ONLY way back from an AT+CRESET. Every reset site (configure_gnss's
# apply-reset tail, recover_modem_reset — which the dead-zone nudge reuses —
# and any future rung) must exit through here so no path can forget a step.
# Contract: call immediately after issuing AT+CRESET. Returns 0 with the GNSS
# engine started (SUPL mode attempted per F4), XTRA validity verified (stale ->
# xtra_maintain throttle cleared), antenna bias re-asserted from settings, and
# the engine/bias check throttles zeroed. Returns 1 only if the modem never
# came back on USB — the caller decides what that means for its path.
gnss_recover_after_reset() {
    wait_for_modem_reboot || return 1
    log "Modem back after reset — running unified GNSS recovery."
    if [[ "$ENABLE_GPS" != "1" ]]; then
        log "GNSS recovery skipped (SIM7600_ENABLE_GPS=$ENABLE_GPS)."
        return 0
    fi
    # F10/F11: right after re-enumeration the modem serves boot-default config
    # answers and auto-restarts the GNSS engine on its own (~10 s in). Sit that
    # window out so we act on the engine's true state instead of racing it.
    log "Settling ${GNSS_RESET_SETTLE_SECS}s for NV load + GNSS auto-restart (F10/F11)..."
    sleep "$GNSS_RESET_SETTLE_SECS"
    # XTRA auto-inject re-assert. Must follow the settle: the command is
    # rejected with "+CME ERROR: XTRA Disabled" until CGPSXE=1 is in effect.
    if [[ "$GNSS_XTRA" == "1" ]]; then
        at_cmd "AT+CGPSXDAUTO=1" 1
    fi
    # F11: the auto-restarted engine runs plain (1,1) — the reset already cost
    # us its acquisition, and no SUPL start was ever issued. One stop followed
    # by a settled gps_start is the sanctioned post-reset SUPL-mode start.
    # (NOT the F5 flapping non-goal: that forbids restarting a healthy running
    # session because AT+CGPS? read 1,1 after a SUPL auto-fallback.)
    gps_stop
    gps_start
    # Verify XTRA assistance survived the reset (file lives in module flash).
    local valid
    valid=$(at_setting_confirmed "AT+CGPSXTRADATA?" "CGPSXTRADATA" | cut -d, -f1 | tr -d ' ')
    [[ -n "$valid" ]] && XTRA_VALID_MIN=$valid
    if [[ -n "$valid" && "$valid" -ge "$XTRA_MIN_VALID_MIN" ]]; then
        log "XTRA assistance intact after reset (valid ${valid} min)."
    else
        warn "XTRA validity ${valid:-unknown} min after reset — clearing throttle so xtra_maintain re-downloads on the next healthy tick."
        LAST_XTRA_CHECK=0
    fi
    # The reset reverted the antenna bias LDO; re-assert from settings NOW
    # rather than waiting for a healthy link (dead-zone resets may not see one
    # for a long time). Zero the throttles so the health loop re-checks soon.
    gnss_bias_apply "$(gnss_bias_desired)"
    LAST_BIAS_CHECK=0
    LAST_GNSS_CHECK=0
    log "Unified GNSS recovery complete."
}

# --- Recovery ladder ----------------------------------------------------------
# Escalating interventions for connect cycles that keep failing. A plain
# NETOPEN+dhclient retry cannot fix a wedged data call: the DHCP lease comes
# from the modem's internal NAT and succeeds regardless of WAN state. These
# operate on the thing that is actually broken — the modem's network attach.

# L1 — PS re-attach + operator reselect. Cheapest; fixes a stale PDP/attach
# left behind when the network detached us during a long outage.
recover_reattach() {
    warn "Recovery L1: PS re-attach (AT+CGATT 0/1) + operator reselect (AT+COPS 2/0)..."
    at_query "AT+CGATT=0" 15 >/dev/null
    sleep 2
    at_query "AT+CGATT=1" 15 >/dev/null
    at_query "AT+COPS=2" 15 >/dev/null
    sleep 2
    at_query "AT+COPS=0" 20 >/dev/null
}

# L2 — radio cycle (airplane-mode bounce). Forces a full cell reselection and
# fresh registration; recovers a radio that stopped cell-searching.
LAST_RADIO_CYCLE=0
recover_radio_cycle() {
    local now
    now=$(date +%s)
    if (( now - LAST_RADIO_CYCLE < RADIO_CYCLE_COOLDOWN )); then
        warn "Recovery L2 skipped — radio cycle on cooldown ($(( RADIO_CYCLE_COOLDOWN - (now - LAST_RADIO_CYCLE) ))s left; re-registration TX bursts are power-expensive)."
        return 0
    fi
    LAST_RADIO_CYCLE=$now
    warn "Recovery L2: radio cycle (AT+CFUN=0 -> AT+CFUN=1)..."
    at_query "AT+CFUN=0" 15 >/dev/null
    sleep 5
    at_query "AT+CFUN=1" 20 >/dev/null
    sleep 5
}

# L3 — full modem reboot. The nuclear option: equivalent to power-cycling the
# module. The modem drops off USB and re-enumerates, so we must re-wait for
# the serial port and re-assert GNSS state afterwards.
LAST_MODEM_RESET=0
recover_modem_reset() {
    local now
    now=$(date +%s)
    if (( now - LAST_MODEM_RESET < MODEM_RESET_COOLDOWN )); then
        warn "Recovery L3 skipped — modem reset on cooldown ($(( MODEM_RESET_COOLDOWN - (now - LAST_MODEM_RESET) ))s left; a reset's boot + attach draws ~2A bursts)."
        return 0
    fi
    LAST_MODEM_RESET=$now
    err "Recovery L3: full modem reset (AT+CRESET)..."
    at_query "AT+CRESET" 5 >/dev/null
    # The shared routine owns the reset exit: engine restart (SUPL mode), XTRA
    # verify, bias re-assert. GNSS NV config survives the reset, so a full
    # configure_gnss re-read pass is not needed (and would land its reads in
    # the F10 boot-default window for nothing).
    gnss_recover_after_reset || return 1
}

# Consecutive failed connect cycles (reset by the health monitor on the first
# successful ping). Drives the ladder: 1 plain retry, 2 re-attach, 3 radio
# cycle, 4 modem reset — then the ladder repeats while failures continue.
CONNECT_FAILS=0
escalate_recovery() {
    (( CONNECT_FAILS >= 2 )) || return 0
    case $(( (CONNECT_FAILS - 2) % 3 )) in
        0) recover_reattach ;;
        1) recover_radio_cycle ;;
        2) recover_modem_reset || warn "Modem reset recovery failed; ladder will retry." ;;
    esac
}

teardown_interface() {
    if ip link show "$IFACE" &>/dev/null; then
        log "Tearing down $IFACE..."
        dhclient -r "$IFACE" 2>/dev/null || true
        # dhclient -r only releases the newest lease; stale addresses from
        # earlier cycles (or a meddling NetworkManager) linger and can become
        # the ping source address, which the modem's NAT silently drops.
        pkill -f "dhclient.*$IFACE" 2>/dev/null || true
        ip addr flush dev "$IFACE" 2>/dev/null || true
        ip link set "$IFACE" down 2>/dev/null || true
    fi
    at_cmd "AT+NETCLOSE" 2
}

bring_up_interface() {
    # The RNDIS data call is dialed by the modem firmware; make sure it is
    # actually up modem-side before touching the host interface at all.
    if ! wan_ip_up; then
        log "PDP context 1 has no WAN address — activating (AT+CGACT=1,1)..."
        at_query "AT+CGACT=1,1" 30 >/dev/null
        if ! wan_ip_up; then
            warn "PDP context still has no WAN address; data call is down modem-side."
            return 1
        fi
    fi

    log "Opening modem network context (AT+NETOPEN)..."
    at_cmd "AT+NETOPEN" 3

    # The netdev vanishes across modem resets/re-enumeration — wait for it.
    local tries=0
    while ! ip link show "$IFACE" &>/dev/null; do
        (( tries++ ))
        if (( tries > 15 )); then
            err "Interface $IFACE never appeared."
            return 1
        fi
        sleep 2
    done

    # Own the interface exclusively: no leftover dhclient, no stale addresses.
    pkill -f "dhclient.*$IFACE" 2>/dev/null || true
    ip addr flush dev "$IFACE" 2>/dev/null || true
    ip link set "$IFACE" up 2>/dev/null || true

    log "Running dhclient on $IFACE..."
    timeout 45 dhclient -1 -v "$IFACE" 2>&1 | tee -a /var/log/sim7600-lte.log
    local dh_status="${PIPESTATUS[0]}"
    if [[ "$dh_status" -ne 0 ]]; then
        err "dhclient failed on $IFACE (exit $dh_status)."
        return 1
    fi
    log "Interface $IFACE is up."
    ip addr show "$IFACE" | grep "inet " | tee -a /var/log/sim7600-lte.log

    # dhclient installs its default route at metric 0, which would out-rank
    # WiFi (metric 50) and steal the whole uplink. Re-install it at
    # LTE_ROUTE_METRIC so LTE stays the fallback path.
    local gw
    gw=$(ip route show dev "$IFACE" default 2>/dev/null | awk '{print $3; exit}')
    if [[ -n "$gw" ]]; then
        ip route del default via "$gw" dev "$IFACE" 2>/dev/null || true
        ip route replace default via "$gw" dev "$IFACE" metric "$LTE_ROUTE_METRIC" 2>/dev/null || true
    fi

    # Verify END-TO-END connectivity before declaring victory: the DHCP lease
    # is granted by the modem's own NAT and proves nothing about the WAN.
    local i
    for i in 1 2 3; do
        if ping -c 1 -W 4 -I "$IFACE" "$PING_HOST" &>/dev/null; then
            return 0
        fi
        sleep 3
    done
    err "No end-to-end connectivity through $IFACE after DHCP — WAN side is dead."
    return 1
}

# --- Signal wait loop --------------------------------------------------------
wait_for_stable_signal() {
    log "Waiting for stable LTE signal (min CSQ=$MIN_CSQ, need $SIGNAL_STABLE_COUNT consecutive reads >= $GOOD_CSQ, registered)..."
    local stable_count=0
    local prev_csq=99
    local interval=$CSQ_INTERVAL_WEAK
    # Wedge detection: if the modem has had no usable service (signal +
    # registration) for DEADZONE_NUDGE_SECS, it may have stopped searching —
    # nudge the radio, then escalate to a full modem reset.
    local no_service_since nudge_level=0
    no_service_since=$(date +%s)

    while true; do
        local csq dbm
        csq=$(get_csq)
        maybe_update_modem_temp
        dbm=$(csq_to_dbm "$csq")
        interval=$(adaptive_interval "$csq" "$prev_csq")

        if [[ "$csq" -eq 99 ]]; then
            warn "Signal unknown (CSQ=99) — modem may still be registering. [poll=${interval}s]"
            stable_count=0
            write_telemetry "$csq" "disconnected" "$interval"

        elif [[ "$csq" -lt "$MIN_CSQ" ]]; then
            warn "Signal too weak: CSQ=$csq ($dbm). Waiting... [poll=${interval}s]"
            stable_count=0
            write_telemetry "$csq" "dead_zone" "$interval"

        elif [[ "$csq" -ge "$GOOD_CSQ" ]]; then
            if is_registered; then
                no_service_since=$(date +%s)
                nudge_level=0
                (( stable_count++ ))
                # We are actively trying to connect — poll fast regardless of
                # what the adaptive backoff says, so reconnects aren't delayed
                # by the 30s "stable" interval.
                interval=$CSQ_INTERVAL_FAST
                log "Good signal: CSQ=$csq ($dbm), registered (stat=$LAST_REG) [$stable_count/$SIGNAL_STABLE_COUNT stable] [poll=${interval}s]"
                write_telemetry "$csq" "connecting" "$interval"
                if [[ "$stable_count" -ge "$SIGNAL_STABLE_COUNT" ]]; then
                    log "Signal stable and registered. Proceeding with connection."
                    return 0
                fi
            else
                # RF is fine but the network doesn't have us — the classic
                # post-outage wedge. Never connect in this state; the nudge
                # timer below is what gets us out if it persists.
                warn "Good signal (CSQ=$csq, $dbm) but NOT registered (stat=$LAST_REG). Waiting for network attach... [poll=${interval}s]"
                stable_count=0
                write_telemetry "$csq" "disconnected" "$interval"
            fi

        else
            log "Marginal signal: CSQ=$csq ($dbm). Waiting for improvement... [poll=${interval}s]"
            stable_count=0
            write_telemetry "$csq" "disconnected" "$interval"
        fi

        local now
        now=$(date +%s)
        if (( now - no_service_since > DEADZONE_NUDGE_SECS )); then
            (( nudge_level++ ))
            warn "No usable service for ${DEADZONE_NUDGE_SECS}s (nudge #$nudge_level) — modem may be wedged."
            if (( nudge_level == 1 )); then
                recover_radio_cycle
            else
                recover_modem_reset || warn "Modem reset during dead-zone wait failed; will retry."
            fi
            no_service_since=$(date +%s)
            stable_count=0
        fi

        prev_csq="$csq"
        sleep "$interval"
    done
}

# --- Health monitor ----------------------------------------------------------
# Exit codes:
#   1 — reconnect needed (ping failed, signal OK → network/carrier issue)
#   2 — dead zone (ping failed, signal weak → wait for signal recovery)
monitor_connection() {
    log "Connection monitor started. Pinging $PING_HOST every ${HEALTH_CHECK_INTERVAL}s."
    local fail_count=0
    local prev_csq=99

    while true; do
        sleep "$HEALTH_CHECK_INTERVAL"

        local csq dbm interval
        csq=$(get_csq)
        maybe_update_modem_temp
        dbm=$(csq_to_dbm "$csq")
        interval=$(adaptive_interval "$csq" "$prev_csq")
        prev_csq="$csq"

        if ping -c 2 -W 4 -I "$IFACE" "$PING_HOST" &>/dev/null; then
            fail_count=0
            # A verified-healthy link heals the recovery ladder.
            CONNECT_FAILS=0
            write_telemetry "$csq" "connected" "$interval"
            log "Health OK — CSQ=$csq ($dbm) [poll=${interval}s]"
            # GNSS upkeep while the link is healthy (all self-throttle).
            gnss_reassert
            xtra_maintain
            gnss_bias_maintain
        else
            (( fail_count++ ))
            warn "Ping failed ($fail_count/$HEALTH_FAIL_THRESHOLD) — CSQ=$csq ($dbm)"
            write_telemetry "$csq" "disconnected" "$interval"

            if [[ "$fail_count" -ge "$HEALTH_FAIL_THRESHOLD" ]]; then
                if [[ "$csq" -eq 99 || "$csq" -lt "$MIN_CSQ" ]]; then
                    err "Connection lost — signal too weak (CSQ=$csq). Entering dead zone wait."
                    return 2
                else
                    update_reg
                    err "Connection lost — signal OK (CSQ=$csq, reg=$LAST_REG) but ping failing. Network issue, reconnecting."
                    return 1
                fi
            fi
        fi
    done
}

# --- Main loop ---------------------------------------------------------------
main() {
    log "============================================"
    log " sim7600-lte connection manager starting"
    log " Serial:    $SERIAL"
    log " Interface: $IFACE"
    log " Telemetry: $TELEMETRY_FILE"
    log "============================================"

    log "Waiting ${MODEM_BOOT_WAIT}s for modem USB enumeration..."
    sleep "$MODEM_BOOT_WAIT"

    wait_for_serial || exit 1
    wait_for_modem_ready || exit 1

    # Configure + start GNSS once the AT interface is up so NMEA flows on the
    # GPS port. May AT+CRESET once on first boot (or config drift) to apply
    # NV settings; a failure here must not block the LTE uplink.
    configure_gnss || warn "GNSS configuration failed; continuing with LTE only."

    while true; do
        # 1. Wait for stable signal AND network registration
        wait_for_stable_signal

        # 2. Bring up interface (verified end-to-end before it returns 0)
        if bring_up_interface; then
            log "LTE connection established (verified end-to-end)."

            # Data is up: fetch/refresh XTRA assistance now (self-throttled).
            xtra_maintain

            # 3. Monitor — exit code tells us why it failed
            monitor_connection
            local monitor_exit=$?

            # 4. Teardown
            warn "Tearing down connection..."
            teardown_interface

            if [[ "$monitor_exit" -eq 2 ]]; then
                # Dead zone — go straight back to signal wait, no reconnect
                # delay, and no ladder escalation: losing signal is expected
                # in the field, not a fault to punish the modem for.
                log "Dead zone detected. Waiting for signal recovery..."
                continue
            fi
            (( CONNECT_FAILS++ ))
        else
            err "Failed to bring up interface."
            teardown_interface
            (( CONNECT_FAILS++ ))
        fi

        # 5. Escalate when plain retries aren't working
        escalate_recovery

        # Backed-off retry delay: 5s, 10s, ... capped at RECONNECT_DELAY_MAX.
        local delay=$(( RECONNECT_DELAY * CONNECT_FAILS ))
        (( delay > RECONNECT_DELAY_MAX )) && delay=$RECONNECT_DELAY_MAX
        (( delay < RECONNECT_DELAY )) && delay=$RECONNECT_DELAY
        log "Retrying in ${delay}s (consecutive failed cycles: $CONNECT_FAILS)..."
        sleep "$delay"
        log "--- Reconnect attempt ---"
    done
}

main "$@"
