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
#   - Atomic JSON telemetry output for consumption by other processes
#   - Automatic reconnect on link failure
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
RECONNECT_DELAY=5            # wait before attempting reconnect
AT_CMD_DELAY=1               # pause between AT commands
MODEM_BOOT_WAIT=8            # initial wait for modem USB enumeration

# Adaptive CSQ polling intervals (seconds)
CSQ_INTERVAL_FAST=3          # signal changing rapidly (delta >= CSQ_RAPID_DELTA)
CSQ_INTERVAL_WEAK=5          # signal weak / recovering (CSQ < MIN_CSQ)
CSQ_INTERVAL_STABLE=30       # signal stable and connected
CSQ_RAPID_DELTA=3            # CSQ change threshold to trigger fast polling

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
#   "iface":        interface name
#   "ip":           current IP string, or null
#   "xtra_valid_min": minutes of GNSS XTRA assistance validity left, or null
#   "gnss_ant_bias": 0|1 last-applied antenna bias state, or null before first apply
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
  "iface": "$IFACE",
  "ip": $ip,
  "xtra_valid_min": ${XTRA_VALID_MIN:-null},
  "gnss_ant_bias": ${GNSS_BIAS_APPLIED:-null}
}
EOF

    mv "$tmp" "$TELEMETRY_FILE"
}

# --- AT command helpers -------------------------------------------------------
at_cmd() {
    local cmd="$1"
    local wait="${2:-$AT_CMD_DELAY}"
    echo -e "${cmd}\r" > "$SERIAL"
    sleep "$wait"
}

at_query() {
    local cmd="$1"
    echo -e "${cmd}\r" > "$SERIAL"
    timeout 2 cat "$SERIAL" 2>/dev/null | tr -d '\r'
}

# Send a command and wait (up to $2 seconds) for a line matching $3 — for
# commands that answer with a delayed URC (XTRA download, HTP time sync).
# grep -m1 returns as soon as the URC lands, so the happy path doesn't burn
# the full timeout. Prints the matched line, or nothing on timeout.
at_wait_urc() {
    local cmd="$1" secs="$2" pattern="$3"
    echo -e "${cmd}\r" > "$SERIAL"
    timeout "$secs" grep -m1 -aE "$pattern" "$SERIAL" 2>/dev/null | tr -d '\r'
}

# --- Signal quality ----------------------------------------------------------
get_csq() {
    local raw
    raw=$(at_query "AT+CSQ" | grep "+CSQ:" | head -1)
    local val
    val=$(echo "$raw" | sed -n 's/.*+CSQ: \([0-9]*\),.*/\1/p')
    echo "${val:-99}"
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

gps_start() {
    if gps_engine_on; then
        return
    fi
    if [[ -n "$SUPL_URL" ]]; then
        log "Starting GNSS in UE-based AGPS mode (AT+CGPS=1,2; falls back to standalone)..."
        at_cmd "AT+CGPS=1,2" 2
    else
        log "Starting GNSS in standalone mode (AT+CGPS=1,1)..."
        at_cmd "AT+CGPS=1,1" 2
    fi
    # Some firmware rejects the mode argument when a previous session is still
    # winding down — a plain start is better than no GNSS at all.
    if ! gps_engine_on; then
        warn "GNSS start with explicit mode not accepted; retrying plain AT+CGPS=1."
        at_cmd "AT+CGPS=1" 2
    fi
}

# Read a "+PREFIX: value" style current setting; prints the raw value part.
at_setting() {
    local cmd="$1" prefix="$2"
    at_query "$cmd" | sed -n "s/.*+${prefix}: *//p" | head -1
}

# One-time (idempotent) GNSS configuration. Compares each persisted setting
# and only writes on drift, so a normal boot makes no config writes and no
# modem reset. Settings that need the engine stopped stop it first; settings
# that only apply after a module restart set need_reset, and we AT+CRESET
# once at the end (values persist in NV, so the post-reset pass is a no-op).
configure_gnss() {
    if [[ "$ENABLE_GPS" != "1" ]]; then
        log "GNSS setup skipped (SIM7600_ENABLE_GPS=$ENABLE_GPS)."
        return
    fi

    local need_reset=0 cur

    # Constellations + DPO (persists in NV; module restart to take effect).
    cur=$(at_setting "AT+CGNSSMODE?" "CGNSSMODE" | tr -d ' ')
    if [[ -z "$cur" ]]; then
        warn "AT+CGNSSMODE not supported (old firmware?) — staying on firmware default constellations."
    elif [[ "$cur" != "$GNSS_MODE,$GNSS_DPO" ]]; then
        log "GNSS constellations: $cur -> $GNSS_MODE,$GNSS_DPO (AT+CGNSSMODE)."
        gps_stop
        at_cmd "AT+CGNSSMODE=$GNSS_MODE,$GNSS_DPO" 2
        need_reset=1
    fi

    # XTRA enable (module restart to take effect).
    cur=$(at_setting "AT+CGPSXE?" "CGPSXE" | tr -d ' ')
    if [[ -n "$cur" && "$cur" != "$GNSS_XTRA" ]]; then
        log "GNSS XTRA: $cur -> $GNSS_XTRA (AT+CGPSXE)."
        gps_stop
        at_cmd "AT+CGPSXE=$GNSS_XTRA" 2
        need_reset=1
    fi

    # SUPL server for UE-based AGPS (module restart to take effect).
    if [[ -n "$SUPL_URL" ]]; then
        cur=$(at_setting "AT+CGPSURL?" "CGPSURL" | tr -d '"')
        if [[ "$cur" != "$SUPL_URL" ]]; then
            log "AGPS SUPL server: '${cur:-unset}' -> $SUPL_URL (AT+CGPSURL)."
            gps_stop
            at_cmd "AT+CGPSURL=\"$SUPL_URL\"" 1
            at_cmd "AT+CGPSSSL=0" 1
            need_reset=1
        fi
    fi

    # NMEA sentence mask (needs the engine stopped, no restart).
    cur=$(at_setting "AT+CGPSNMEA?" "CGPSNMEA" | tr -d ' ')
    if [[ -n "$cur" && "$cur" != "$NMEA_MASK" ]]; then
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
        sleep "$MODEM_BOOT_WAIT"
        wait_for_serial || return 1
        wait_for_modem_ready || return 1
        log "Modem back after GNSS config reset."
    fi

    # XTRA auto-inject at GPS start. Must run AFTER the reset: the command is
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
    valid=$(at_setting "AT+CGPSXTRADATA?" "CGPSXTRADATA" | cut -d, -f1 | tr -d ' ')
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
    valid=$(at_setting "AT+CGPSXTRADATA?" "CGPSXTRADATA" | cut -d, -f1 | tr -d ' ')
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
        warn "GNSS engine found off — restarting it."
        gps_start
    fi
}

# --- Modem / interface helpers -----------------------------------------------
wait_for_serial() {
    log "Waiting for modem serial port $SERIAL..."
    local attempts=0
    while [[ ! -c "$SERIAL" ]]; do
        sleep 2
        (( attempts++ ))
        if (( attempts > 30 )); then
            err "Serial port $SERIAL never appeared. Is the modem enumerated?"
            return 1
        fi
    done
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

teardown_interface() {
    if ip link show "$IFACE" &>/dev/null; then
        log "Tearing down $IFACE..."
        dhclient -r "$IFACE" 2>/dev/null || true
        ip link set "$IFACE" down 2>/dev/null || true
    fi
    at_cmd "AT+NETCLOSE" 2
}

bring_up_interface() {
    log "Opening modem network context (AT+NETOPEN)..."
    at_cmd "AT+NETOPEN" 3

    log "Running dhclient on $IFACE..."
    if dhclient -v "$IFACE" 2>&1 | tee -a /var/log/sim7600-lte.log; then
        log "Interface $IFACE is up."
        ip addr show "$IFACE" | grep "inet " | tee -a /var/log/sim7600-lte.log
        return 0
    else
        err "dhclient failed on $IFACE."
        return 1
    fi
}

# --- Signal wait loop --------------------------------------------------------
wait_for_stable_signal() {
    log "Waiting for stable LTE signal (min CSQ=$MIN_CSQ, need $SIGNAL_STABLE_COUNT consecutive reads >= $GOOD_CSQ)..."
    local stable_count=0
    local prev_csq=99
    local interval=$CSQ_INTERVAL_WEAK

    while true; do
        local csq dbm
        csq=$(get_csq)
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
            (( stable_count++ ))
            log "Good signal: CSQ=$csq ($dbm) [$stable_count/$SIGNAL_STABLE_COUNT stable] [poll=${interval}s]"
            write_telemetry "$csq" "connecting" "$interval"
            if [[ "$stable_count" -ge "$SIGNAL_STABLE_COUNT" ]]; then
                log "Signal stable. Proceeding with connection."
                return 0
            fi

        else
            log "Marginal signal: CSQ=$csq ($dbm). Waiting for improvement... [poll=${interval}s]"
            stable_count=0
            write_telemetry "$csq" "disconnected" "$interval"
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
        dbm=$(csq_to_dbm "$csq")
        interval=$(adaptive_interval "$csq" "$prev_csq")
        prev_csq="$csq"

        if ping -c 2 -W 4 -I "$IFACE" "$PING_HOST" &>/dev/null; then
            fail_count=0
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
                    err "Connection lost — signal OK (CSQ=$csq) but ping failing. Network issue, reconnecting."
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
        # 1. Wait for stable signal
        wait_for_stable_signal

        # 2. Bring up interface
        if bring_up_interface; then
            log "LTE connection established."

            # Data is up: fetch/refresh XTRA assistance now (self-throttled).
            xtra_maintain

            # 3. Monitor — exit code tells us why it failed
            monitor_connection
            local monitor_exit=$?

            # 4. Teardown
            warn "Tearing down connection..."
            teardown_interface

            if [[ "$monitor_exit" -eq 2 ]]; then
                # Dead zone — go straight back to signal wait, no reconnect delay
                log "Dead zone detected. Waiting for signal recovery..."
                continue
            fi
        else
            err "Failed to bring up interface."
        fi

        log "Retrying in ${RECONNECT_DELAY}s..."
        sleep "$RECONNECT_DELAY"
        log "--- Reconnect attempt ---"
    done
}

main "$@"
