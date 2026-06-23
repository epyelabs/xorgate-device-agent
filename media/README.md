# media/ — KVS WebRTC runtime

`xorgate-kvs-webrtc` is the compiled AWS KVS WebRTC **master** runtime (ARM aarch64),
built from [`xorgate/device/xorgate-kvs-webrtc`](../../xorgate-kvs-webrtc). The device
agent's media collector ([`src/agent/collectors/media.ts`](../src/agent/collectors/media.ts))
supervises one instance of it per KVS signaling channel so the device streams live video
to the frontend's Streams-tab viewer.

It is invoked as `xorgate-kvs-webrtc <channelName> <mediaType> <source>` (e.g.
`<deviceId>-cam0 video-only testsrc`) with the device's IoT credentials passed via the
environment (see the collector). On the device it lands at `/opt/xorgate/media/`.

## `lib/` — shared libraries (supplied separately)

The binary is **dynamically linked**. Per `ldd` on the reference Pi, these are the libs it
resolves out of the SDK build tree (not apt packages), so they must live here in `lib/` and
travel with the binary. The runtime is launched with `LD_LIBRARY_PATH` pointed here
(`/opt/xorgate/media/lib` on a device):

| File | Built into | Note |
|------|------------|------|
| `libkvsWebrtcClient.so` | `…/build/` | srtp2 / usrsctp / kvspic\* are statically linked inside |
| `libkvsWebrtcSignalingClient.so` | `…/build/` | |
| `libkvsCommonLws.so.1` | `…/open-source/lib/` | |
| `libwebsockets.so.19` | `…/open-source/lib/` | SDK-vendored |
| `libssl.so.1.1` | `…/open-source/lib/` | **OpenSSL 1.1**, vendored (current Pi OS ships OpenSSL 3) |
| `libcrypto.so.1.1` | `…/open-source/lib/` | **OpenSSL 1.1**, vendored |

GStreamer + glib (and their deps) come from **apt** and are installed by the device install
script. OpenSSL and libwebsockets are **not** taken from apt — the SDK vendors its own
OpenSSL 1.1, which differs from the system OpenSSL 3, so those ship here.

Pull them off the build device with [`fetch-kvs-libs.sh`](fetch-kvs-libs.sh) (asks the Pi's
`ldd` what the binary links and scp's exactly those into `lib/`):

```sh
media/fetch-kvs-libs.sh pi@10.0.0.111
```

Until the libs are present, the runtime exits immediately on start; the media collector
detects the repeated quick failures, logs once, and parks the channel (it never tight-loops).
Drop the libs in, then `xorgate set media on` and restart the agent.
