# syntax=docker/dockerfile:1
# Xorgate device simulator image (device-simulator plan, Phase 0 spike).
#
# The REAL xorgate-device-agent in a container, with the in-house
# `xorgate-kvs-webrtc` master built from source for the image's own
# architecture (the shipped binary is aarch64 only; the homelab is x86_64 with
# no arm64 emulation). Three stages:
#   kvs-build   ubuntu 24.04 + GStreamer dev + AWS KVS WebRTC C SDK (the
#               fork's pinned tag) + the fork's master; the SDK-tree libs the
#               binary resolves are collected via ldd (same approach as
#               media/fetch-kvs-libs.sh on a Pi).
#   agent-build node 22: `npm ci && tsc`, then production deps only.
#   runtime     ubuntu 24.04 + GStreamer runtime (incl. libav for the replay
#               decoder) + node 22 + the two artifacts above under /opt/xorgate.
#
# Ubuntu 24.04 (GStreamer 1.24), NOT 22.04 (1.20), on purpose: on 1.20 a
# `filesrc ! … ! avdec_h264 ! … ! shmsink` chain with no queue in front of the
# sink stalls after ~1 s (the bridge-only pipeline the agent runs when
# recording is off), while the same chain flows on 1.24 — measured in the
# Phase 0 spike. The Pi runs 1.22.
#
# Build context is `device/` (needs both repos):
#   docker build -f xorgate-device-agent/sim/Dockerfile -t xorgate-sim:dev .
FROM ubuntu:24.04 AS kvs-build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates cmake m4 pkg-config build-essential \
      libssl-dev libcurl4-openssl-dev liblog4cplus-dev \
      libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  && rm -rf /var/lib/apt/lists/*
# The fork pins the SDK as a submodule at this tag (xorgate-kvs-webrtc/.gitmodules).
ARG KVS_SDK_TAG=v1.19.1
RUN git clone --depth 1 --branch ${KVS_SDK_TAG} \
      https://github.com/awslabs/amazon-kinesis-video-streams-webrtc-sdk-c.git /sdk
# SDK first (samples off; it fetches + builds its own openssl/libwebsockets/srtp/usrsctp).
RUN cmake -S /sdk -B /sdk/build -DBUILD_SAMPLE=OFF \
  && make -C /sdk/build -j"$(nproc)"
COPY xorgate-kvs-webrtc/CMakeLists.txt /app/CMakeLists.txt
COPY xorgate-kvs-webrtc/src /app/src
RUN cmake -S /app -B /app/build -DKVS_SDK_DIR=/sdk \
  && make -C /app/build -j"$(nproc)" xorgate-kvs-webrtc
# Runtime layout mirrors the device tarball's media/: binary + cert.pem + lib/.
RUN mkdir -p /out/lib \
  && cp /app/build/xorgate-kvs-webrtc /out/ \
  && cp /sdk/certs/cert.pem /out/cert.pem \
  && ldd /out/xorgate-kvs-webrtc | awk '/=> \/sdk\//{print $3}' | xargs -I{} cp -L {} /out/lib/ \
  && ls -la /out/lib

FROM node:22-bookworm-slim AS agent-build
WORKDIR /agent
COPY xorgate-device-agent/package.json xorgate-device-agent/package-lock.json ./
RUN npm ci
COPY xorgate-device-agent/tsconfig.json ./
COPY xorgate-device-agent/src ./src
RUN npm run build && npm prune --omit=dev

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg jq procps \
      gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav \
      libcurl4t64 libssl3t64 \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kvs-build /out /opt/xorgate/media
# Every shared lib the master needs must resolve here (SDK-tree libs via
# media/lib, the rest from apt above) — fail the build, not the first stream.
RUN ! (LD_LIBRARY_PATH=/opt/xorgate/media/lib ldd /opt/xorgate/media/xorgate-kvs-webrtc | grep "not found")
COPY --from=agent-build /agent/dist /opt/xorgate/dist
COPY --from=agent-build /agent/node_modules /opt/xorgate/node_modules
COPY --from=agent-build /agent/package.json /opt/xorgate/package.json
COPY xorgate-device-agent/sim/entrypoint.sh /entrypoint.sh
COPY xorgate-device-agent/sim/timedatectl /usr/local/bin/timedatectl
RUN chmod +x /entrypoint.sh /usr/local/bin/timedatectl
ENV XORGATE_HOME=/state
WORKDIR /opt/xorgate
ENTRYPOINT ["/entrypoint.sh"]
