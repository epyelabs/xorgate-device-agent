#!/usr/bin/env bash
# Entrypoint for the simulator image (device-simulator plan, Phase 0 spike).
#
# Mounts:  /creds  (cert.crt, private.key, ca.pem, kvs.json — the provision bundle)
#          /assets (scenario cache: <scenario>/cam0/lap.h264 …, read-only)
#          /state  (XORGATE_HOME: settings.json, recordings/, shm/, pipelines/)
# Env:     IOT_DATA_ENDPOINT (required), DEVICE_ID (defaults to kvs.json's),
#          XORGATE_UPLOAD_BUCKET (dev bucket; kvs.json from the test script has none),
#          SCENARIO (default city-2026-09-27), MODE (default sim).
set -euo pipefail

CREDS_DIR="${CREDS_DIR:-/creds}"
ASSETS_DIR="${ASSETS_DIR:-/assets}"
export XORGATE_HOME="${XORGATE_HOME:-/state}"
SCENARIO="${SCENARIO:-city-2026-09-27}"

export CERT_PATH="$CREDS_DIR/cert.crt"
export KEY_PATH="$CREDS_DIR/private.key"
export CA_PATH="$CREDS_DIR/ca.pem"
export KVS_MANIFEST="$CREDS_DIR/kvs.json"
export DEVICE_ID="${DEVICE_ID:-$(jq -r '.deviceId' "$KVS_MANIFEST")}"
[[ -n "${IOT_DATA_ENDPOINT:-}" ]] || { echo "IOT_DATA_ENDPOINT is required" >&2; exit 1; }

# The in-image KVS master (built for this arch) — the explicit KVS_RUNTIME_BIN
# is what unlocks the agent's non-arm64 allowance in detectRuntime().
export KVS_RUNTIME_BIN=/opt/xorgate/media/xorgate-kvs-webrtc
export KVS_RUNTIME_LIB_DIR=/opt/xorgate/media/lib
export KVS_CACERT_PATH=/opt/xorgate/media/cert.pem
export KVS_PIPELINE_DIR="${KVS_PIPELINE_DIR:-$XORGATE_HOME/pipelines}"
export HARDWARE_MANIFEST="${HARDWARE_MANIFEST:-$XORGATE_HOME/hardware.json}"

mkdir -p "$XORGATE_HOME" "$KVS_PIPELINE_DIR" "$XORGATE_HOME/shm"

# Bridged cam0: the KVS master reads the capture daemon's shm socket (the exact
# .gst `xorgate pipeline bridge` renders on a CM5); the `.camera` file is a
# placeholder — the capture HEAD is replaced by XORGATE_CAPTURE_SOURCE_HEAD.
SOCK="$XORGATE_HOME/shm/cam0.sock"
if [[ ! -f "$KVS_PIPELINE_DIR/cam0.gst" ]]; then
  cat > "$KVS_PIPELINE_DIR/cam0.gst" <<GST
shmsrc socket-path=$SOCK is-live=true do-timestamp=true ! video/x-raw,format=I420,width=1280,height=720,framerate=15/1 ! x264enc name=sampleVideoEncoder bframes=0 speed-preset=ultrafast bitrate=1000 byte-stream=TRUE tune=zerolatency threads=2 ! video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline ! appsink sync=TRUE emit-signals=TRUE name=appsink-video
GST
fi
[[ -f "$KVS_PIPELINE_DIR/cam0.camera" ]] || echo "replay:$SCENARIO" > "$KVS_PIPELINE_DIR/cam0.camera"

LAP="$ASSETS_DIR/$SCENARIO/cam0/lap.h264"
[[ -f "$LAP" ]] || { echo "scenario clip not found: $LAP" >&2; exit 1; }

# Sim mode + the two spike gates: supervise KVS masters in sim mode, and swap
# the capture pipeline's libcamerasrc head for a real-time paced file decode.
# Everything after the tee is the agent's unchanged recording/bridge pipeline.
export XORGATE_SIM_MEDIA=1
export XORGATE_CAPTURE_SOURCE_HEAD="${XORGATE_CAPTURE_SOURCE_HEAD:-filesrc location=$LAP ! h264parse ! video/x-h264,framerate=15/1 ! avdec_h264 ! identity sync=true ! videoconvert ! videorate}"

echo "[sim] device=$DEVICE_ID scenario=$SCENARIO home=$XORGATE_HOME bucket=${XORGATE_UPLOAD_BUCKET:-<from config>}"
exec node /opt/xorgate/dist/worker.js --mode "${MODE:-sim}"
