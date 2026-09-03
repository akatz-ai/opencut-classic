# Performance foundations

This fork keeps the Classic editor usable while the upstream Rust rewrite is
still under construction. The first performance pass targets failures that
scale with source duration or asset count before attempting larger proxy-media
or native-engine work.

## Upstream work reviewed

- Imported the streaming waveform approach from
  [`hp-8/opencut-classic@d5c906d`](https://github.com/hp-8/opencut-classic/commit/d5c906dac6ed59c798e1335808974267550d44db),
  then added focused coverage and sample-rate validation.
- Ported the narrow build/type fixes from
  [`OpenCut-app/OpenCut#793`](https://github.com/OpenCut-app/OpenCut/pull/793).
- Reviewed but did not use
  [`#758`](https://github.com/OpenCut-app/OpenCut/pull/758): its frame cache
  API is not connected to the renderer. The current Classic decoder already
  bounds frames per source; this fork instead bounds the number of live
  sources and disposes them on LRU eviction.
- Reviewed but did not use
  [`#460`](https://github.com/OpenCut-app/OpenCut/pull/460): its custom
  `StreamTarget` still writes through MediaBunny's `BufferTarget` and only
  saves after the complete encoded buffer exists.
- Reviewed but did not use
  [`#574`](https://github.com/OpenCut-app/OpenCut/pull/574): the current
  Classic renderer supersedes that earlier draft.
- No open PR directly addressed the GPU texture pool, current timeline
  subscription churn, or repeatable render diagnostics.

## Changes in this pass

- File-backed waveform analysis now uses `AudioBufferSink` chunks instead of
  reading and decoding the complete media file in memory.
- Chrome's File System Access API now feeds MediaBunny's real `StreamTarget`.
  Encoded output is written with 1 MiB staging chunks. Browsers without the API
  retain the previous buffered-download fallback.
- Video decoder sinks are capped by an eight-entry LRU. Eviction closes the
  active iterator and disposes its MediaBunny input.
- Decoded image and sticker source caches are bounded and failed loads no
  longer remain cached permanently.
- Retained intermediate GPU textures are capped at 24 per resolution and 512
  MiB in total. Active frame textures are not removed mid-frame.
- Timeline clips subscribe to a compact selection snapshot, reuse stable event
  callbacks, and are memoized.
- Render diagnostics expose the last rolling report through
  `window.__renderPerfLastReport` and the current window through
  `window.__renderPerfSnapshot()`.
- Tests use a Node-targeted build of the real Rust/WASM module rather than a
  duplicated JavaScript mock.

## Local Rust/WASM development

Set `OPENCUT_LOCAL_WASM=1` in `apps/web/.env.local`, then build the local
browser package before starting or building the web app:

```sh
bun run build:wasm
bun run build:web
```

With the flag unset, the application continues to resolve the published
`opencut-wasm` package.

On the `akatz-arch` NVIDIA/Niri workstation, the verified Chrome launch needs
X11 presentation plus explicit Vulkan/WebGPU enablement:

```sh
google-chrome-stable \
  --user-data-dir=/home/akatz/.local/share/opencut-chrome \
  --app=http://127.0.0.1:3003/projects \
  --ozone-platform=x11 \
  --enable-unsafe-webgpu \
  --enable-features=UseOzonePlatform,VaapiVideoDecoder,VaapiVideoEncoder,Vulkan \
  --disable-backgrounding-occluded-windows \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding
```

The Rust/WASM runtime reports its selected backend in
`window.__opencutGpuBackend`. The verified value is
`BrowserWebGpu:Bgra8Unorm`.

## Initial measured baseline

The bounded smoke project contains two overlapping H.264/AAC 1280x720 clips,
with a five-second 30 fps timeline. A production build exported all 150 frames
through `BrowserWebGpu:Bgra8Unorm` in 4.1 seconds. The resulting 1.8 MiB output
was delivered in three stream writes; the largest write was exactly 1 MiB.

In the representative 60-frame window:

- decoded-canvas texture synchronization: 19.7 ms mean, 35.1 ms p95;
- media frame resolution: 1.7 ms mean, 3.9 ms p95;
- Rust/WASM composition: 1.0 ms mean, 3.5 ms p95;
- 1.5 decoded video textures and 1.38 million pixels uploaded per frame.

The compositor is not the dominant cost. Copying decoded canvas pixels into
GPU textures is the next render-path bottleneck.

Production server memory settled near 206 MiB. The isolated Chrome application
used about 707 MiB with both test clips loaded. Development-mode Next.js memory
is not a useful editor baseline because compiler caches dominate it.

## Deferred work

1. Stream timeline audio mixing instead of creating one full-duration stereo
   `AudioBuffer`. This is necessary before multi-hour exports are safe.
2. Add adaptive preview resolution and proxy media for long-GOP and 4K sources.
3. Investigate direct `VideoFrame`/external-texture ingestion to remove the
   decoded-canvas upload from every frame.
4. Add timeline viewport virtualization only after a large synthetic timeline
   benchmark defines the current break-even point; drag, snap, and box-select
   behavior make premature virtualization risky.
5. Add a native FFmpeg export path for guaranteed AAC-in-MP4 output on Linux.

The repository-wide ESLint command still reports archived-code debt outside
this pass. Changed performance files lint clean, TypeScript passes, the
optimized Next.js build succeeds, all 228 Bun tests pass, and the Rust workspace
tests pass.
