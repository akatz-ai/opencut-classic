# OpenCut media engine

This local Rust binary owns native FFmpeg work that cannot run safely or
reliably in the browser. The Next.js application is only transport glue; media
policy and FFmpeg command construction live in `rust/crates/media`.

Build and verify it with:

```sh
cargo build --release -p opencut-media-engine
target/release/opencut-media-engine health
```

Set `OPENCUT_MEDIA_ENGINE_BIN` to the resulting absolute binary path before
starting the local web application. Native endpoints reject non-loopback and
cross-origin requests.

The engine currently provides:

- 1280x720, at-most-30-fps, short-GOP H.264/AAC preview proxies. NVENC is used
  when available, with `libx264` as the portable fallback.
- MP4 finalization that copies the browser's encoded H.264 stream, builds the
  timeline audio mix from original sources in FFmpeg, encodes stereo AAC, and
  muxes the result without allocating one full-duration browser AudioBuffer.

It does not yet encode composed video frames itself. WebGPU still composes the
timeline and WebCodecs still encodes the video track.
