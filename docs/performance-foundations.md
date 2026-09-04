# Performance foundations

This fork keeps the Classic editor usable while the upstream Rust rewrite is
still under construction. The performance work first targets failures that
scale with source duration or asset count, then reduces the interactive
bandwidth required by high-resolution and long-GOP sources.

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
- A second audit found no open PRs in the archived Classic repository. Current
  OpenCut PRs
  [`#794`](https://github.com/OpenCut-app/OpenCut/pull/794) and
  [`#797`](https://github.com/OpenCut-app/OpenCut/pull/797) include a useful
  server-conversion boundary, but buffer complete inputs and outputs and do not
  implement proxy lifecycle or native export mixing. PR
  [`#757`](https://github.com/OpenCut-app/OpenCut/pull/757) only negotiates
  browser AAC support, while
  [`#484`](https://github.com/OpenCut-app/OpenCut/pull/484) is an unconnected
  Tauri shell. None supplied adaptive rendering, short-GOP proxies, bounded
  native audio export, or the current FFmpeg engine.
- A third audit found two useful UX ideas in the current rewrite: PR
  [`#773`](https://github.com/OpenCut-app/OpenCut/pull/773) reports rendered
  frame count, elapsed time, and ETA, while PR
  [`#765`](https://github.com/OpenCut-app/OpenCut/pull/765) introduces common
  platform output presets. This fork adapted those ideas to Classic's export
  manager, but neither PR implements Classic's renderer, native media path, or
  bitrate/size controls.

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
- Export now exposes aspect-preserving 2160p, 1440p, 1080p, and 720p presets,
  project/60/30/24 fps choices, a 1-100 quality slider, variable or predictable
  rate control, an estimated size, frame count, elapsed time, and ETA.

## Adaptive preview and proxies

- The project canvas remains the logical coordinate system, while the WebGPU
  preview surface is independently sized. `Auto` selects a stable quarter,
  half, three-quarter, or full-resolution surface large enough for the fitted
  viewport and device pixel ratio. The toolbar also exposes explicit Full,
  1/2, and 1/4 modes.
- Video decode sinks resize frames to the render surface before texture upload.
  Cache keys include the requested decode size, so export and preview do not
  accidentally share a low-resolution decoder.
- New and existing video assets above 1280x720, above 30 fps, or unsupported by
  WebCodecs are queued for proxy generation one at a time. Proxies are H.264,
  at most 1280x720/30 fps, and use a 15-frame GOP for responsive seeking.
- The native response streams directly into project-scoped OPFS storage. The
  original remains the source of truth for audio and export; preview scene
  construction swaps in the proxy when it is ready.
- NVENC is preferred on this workstation and `libx264` is the fallback. Proxy
  storage is quota-checked before the response is committed.

## Native FFmpeg audio and MP4 finalization

`apps/media-engine` and `rust/crates/media` provide the shared native FFmpeg
boundary used by both proxies and export. The browser streams encoded video
chunks and each unique audible source into a temporary export session. FFmpeg
then applies trim, retime, pitch policy, delay, gain, mixing, limiting, and AAC
encoding before copying the H.264 video into the final MP4. The final response
streams into the selected file handle and the session is removed.

This path avoids the previous full-duration stereo `AudioBuffer` and guarantees
AAC-in-MP4 on Linux. It is selected for MP4 exports with audio when the native
engine and File System Access destination are available. Animated volume still
uses the browser path so its keyframe interpolation remains exact. WebM,
non-local deployments, and browsers without the save-file API also retain the
browser fallback.

The native API is intentionally loopback-only and rejects cross-origin calls.
Because Classic stores originals in browser OPFS, audio sources must currently
stream once into the native session; a future native shell can replace that
transfer with direct file-path access.

## Export throughput and rate control

`Auto` uses browser WebCodecs for compositing and first-pass H.264 encoding.
That remains the fastest complete render path on this workstation. Linux
Chrome sees the NVIDIA render node through VA-API for decode, but the installed
VA-API driver does not expose an encode entry point, so Chrome cannot directly
select NVENC.

The native engine can accept compositor frames as BGRA and feed them to
`h264_nvenc`, but this requires a full GPU-to-CPU canvas readback and browser
HTTP transfer for every frame. On the 2560x1440/60 walkthrough project, the
experimental path rendered 843 frames in 51 seconds (16.5 fps) while NVENC
utilization remained near 3%. The compositor/readback boundary, not encoder
capacity, is the bottleneck, so additional simultaneous NVENC streams would
increase contention rather than improve one export. The UI keeps this route as
an explicit `NVIDIA NVENC · experimental` option instead of selecting it in
`Auto`.

Predictable size uses a different hybrid path. The browser first renders the
project normally, then the native engine performs a fast H.264 NVENC finishing
pass over the encoded MP4. This avoids per-frame browser readback and can run in
the same FFmpeg process as native timeline audio mixing. Variable bitrate shows
a measured range because simple footage may use substantially less than the
target; predictable mode shows the target estimate and promises a ±5% range.

For the 681.3167-second project at 1920x1080/30 and a 3.0 Mbps target:

| Path                                       | Wall time | Result                                                               |
| ------------------------------------------ | --------: | -------------------------------------------------------------------- |
| Browser WebCodecs VBR render               |     7m34s | 126,719,944 bytes, 1.488 Mbps                                        |
| Browser first pass used for CBR validation |     7m08s | Chrome ignored its CBR hint and produced the byte-identical VBR file |
| Native NVENC finishing pass                |     41.8s | 255,671,408 bytes, 3.002 Mbps                                        |

The predicted no-audio size was 260,603,625 bytes. The final native result was
1.89% smaller, inside the displayed range, and its packet stream passed an
FFmpeg integrity check. Selecting 1080p30 alone reduced the full browser render
from about 17m14s at 2560x1440/60 to 7m34s, a 2.28x wall-time improvement.

## Local Rust/WASM development

Set `OPENCUT_LOCAL_WASM=1` in `apps/web/.env.local`, then build the local
browser package before starting or building the web app:

```sh
bun run build:wasm
bun run build:web
```

With the flag unset, the application continues to resolve the published
`opencut-wasm` package.

On the `akatz-arch` NVIDIA/Niri workstation, the verified installed-PWA launch
uses native Wayland presentation and Chromium's WebGPU service:

```sh
google-chrome-stable \
  --user-data-dir=/home/akatz/.local/share/opencut-chrome \
  --profile-directory=Default \
  --app-id=<installed-opencut-app-id> \
  --ozone-platform=wayland \
  --render-node-override=/dev/dri/renderD128 \
  --enable-features=UseOzonePlatform,VaapiVideoDecoder,VaapiVideoEncoder,WebGPUService,WebGPU \
  --disable-features=Vulkan \
  --disable-backgrounding-occluded-windows \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding
```

`WebGPUService,WebGPU` keeps the measured hardware backend without the warning
banner caused by `--enable-unsafe-webgpu`. The PWA manifest opts into Window
Controls Overlay, and the editor header reserves the platform-reported titlebar
insets so its controls do not collide with minimize, maximize, or close.

The Rust/WASM runtime reports its selected backend in
`window.__opencutGpuBackend`. The verified value is
`BrowserWebGpu:Bgra8Unorm`.

## Measured baselines

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

The controlled 4K fixture is a 12-second, 3840x2160, 30 fps H.264/AAC source
with a 240-frame GOP. Before adaptive rendering, interactive playback uploaded
8.29 million source pixels per changing frame; texture synchronization averaged
102 ms in the sampled playback window.

The deterministic 60-frame preview benchmark on `akatz-arch` measured:

| Configuration         | Elapsed | Throughput | Texture sync mean | Resolve mean | Uploaded pixels/changing frame |
| --------------------- | ------: | ---------: | ----------------: | -----------: | -----------------------------: |
| Full 4K original      |  2.73 s |     22 fps |           39.6 ms |       5.2 ms |                         8.47 M |
| Auto 960x540 original |  0.77 s |     78 fps |            7.9 ms |       4.5 ms |                         0.52 M |
| Auto 960x540 proxy    |  0.50 s |    120 fps |            6.3 ms |       1.6 ms |                         0.52 M |

The native engine generated the fixture's 1280x720 proxy in 1.36 seconds with
NVENC, reducing it from 39.3 MiB to 9.2 MiB. A route-level export test produced
a four-second H.264/AAC MP4 and removed its temporary session. A complete editor
export then rendered and uploaded video, uploaded one audio source, finalized
through native FFmpeg, and streamed a 4.4 MiB MP4 in 63 bounded response chunks.

Three simultaneous full-frame proxy layers completed 60 deterministic frames
in 1.57 seconds (38 fps average). Texture synchronization averaged 24.3 ms and
reached 37.3 ms at p95. This makes lower-copy ingestion a useful future
optimization for projects with several concurrent video layers, but it is no
longer required for ordinary one-layer 30 fps editing.

### Extract-audio scrub regression

A 469 MiB 4K/48 fps source exposed two Chrome shared-memory descriptor leaks.
Waveform analysis converted every decoded audio packet into a Web Audio
`AudioBuffer`, while video upload created a new staging `OffscreenCanvas` for
each changing frame. The renderer accumulated 955 deleted 2 MiB `/dev/shm`
handles, reached 1,023 of its 1,024 file-descriptor limit, and then failed to
allocate GPU command buffers.

Waveforms now use closeable MediaBunny `AudioSample` objects, copy PCM into
reused ordinary arrays, and explicitly close every sample. Extracted video
audio uses the authoring proxy for waveform display and waits for that proxy
instead of scanning a large original. External video uploads reuse one staging
canvas per texture. On the exact recovered project, 600 deterministic frames
left descriptor count unchanged, and 400 real pointer-scrub seeks changed it
from 102 to 97 with no GPU allocation failures.

### Full-resolution export texture regression

A 681.3167-second, 2560x1440/60 fps project exposed a separate WebGPU export
leak. Its timeline contained 24 main clips plus three muted 4K video overlays
and two text overlays. Every changing decoded canvas caused
`uploadTexture` to allocate a new WebGPU texture even when the texture ID and
dimensions were unchanged. During a High MP4 export, the OpenCut Chrome GPU
process reached roughly 5.4 GiB and Chromium began reporting
`Error creating wgpu::Texture`, uninitialized shared-image reads, and an
encoding failure.

External uploads now update the existing texture when its ID and dimensions
match. The encoder also reads from a stable 2D staging canvas rather than the
WebGPU presentation surface, and an encoder error always cancels the MediaBunny
output to release its resources before retry.

The same project completed a full High MP4 export in about 17 minutes. OpenCut
GPU memory remained between 1.1 and 1.25 GiB during rendering and settled below
1 GiB afterward, with no texture-allocation or shared-image errors. The
353,118,710-byte result contains 2560x1440 yuv420p H.264 at 60 fps and stereo
48 kHz AAC; both stream and container durations are 681.3167 seconds.

## Deferred work

1. Preserve animated-volume interpolation in the native FFmpeg filter graph so
   those exports can also leave the full-buffer browser fallback.
2. Investigate direct `VideoFrame`/external-texture or GPU-native NV12 ingestion
   when concurrent full-frame layers become common, or when a zero-readback
   path to NVENC becomes available; the one-layer path has comfortable preview
   headroom and browser encoding currently beats raw BGRA transfer.
3. Add timeline viewport virtualization only after a large synthetic timeline
   benchmark defines the current break-even point; drag, snap, and box-select
   behavior make premature virtualization risky.
4. Move source transfer to native file-path references when Classic runs inside
   a real desktop shell.

The repository-wide ESLint command still reports pre-existing errors in
archived code outside this pass. Changed performance/export files lint clean,
TypeScript passes, the optimized Next.js build succeeds, all 241 Bun tests pass,
and all 19 Rust workspace tests pass.
