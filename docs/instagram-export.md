# Instagram-sized export presets

The export panel keeps Project, 2160p, 1440p, 1080p and 720p and adds:

| Preset | Portrait | Landscape |
| --- | --- | --- |
| Insta HD | 1080×1920 | 1920×1080 |
| Insta 2K | 1440×2560 | 2560×1440 |
| Insta 4K | 2160×3840 | 3840×2160 |

Orientation follows the project canvas, not the source clip. Square canvases use
the landscape frame. These are exact output-size shortcuts, not a claim that
Instagram will retain that resolution or avoid recompression.

The older numeric presets still preserve the project's aspect ratio. The new
Insta presets use exact 9:16/16:9 dimensions. Other canvas ratios are centered
with black padding, never automatically cropped or stretched. Project settings
and timeline transforms are not modified. For example, a 2688×1536 canvas exports
as 3840×2160 with 3780×2160 content and 30 pixels of padding on either side.

Encoding quality controls the target bitrate only. Every setting uses the full
chosen output dimensions. At 100%, the existing MP4 formula targets 29.9 Mbps for
4K/30 fps (59.7 Mbps for 4K/60 fps); this is not lossless. Variable bitrate may
produce a smaller file on simple scenes. Upscaling does not recover missing
source detail. Export uses original media rather than preview proxies.

## Implementation

- `rust/crates/export-settings`: output dimensions, validation and contain-fit.
- `rust/wasm/src/export_settings.rs`: WASM bindings.
- `apps/web/src/export/settings.ts`: labels and typed frontend adapters.
- `apps/web/src/components/editor/export-button.tsx`: selection, exact dimensions,
  padding explanation and compression explanation.
- `SceneExporter`: renders the project near final output resolution, then centers
  it on the exact encoding canvas. The browser and native sinks share this path.
- `CanvasRenderer.renderToCanvas`: optional destination rectangle with black fill.
- `apps/web/next.config.ts`: explicit workspace WASM entrypoint. An installed
  `opencut-wasm@0.2.10` package lacks the fork's motion/rough-cut/export exports.
  Build the workspace WASM before building Next.

## Verification

Unit tests: `cargo test -p export-settings` and
`bun test --preload ./apps/web/test/setup.mjs apps/web/src/export/__tests__`.
Build WASM for both the node test harness and the browser as documented in the
root package scripts. Type-check from `apps/web` using `bunx tsc --noEmit`.

The real-browser smoke test is `apps/agent/test/instagram-export.mjs`. Run a
separate production server on port 3004, then set `PLAYWRIGHT_MODULE` to a local
Playwright installation and run it with Node. Set `OPENCUT_AGENT_BRIDGE_DIR` on
the test server to its own temporary directory to isolate bridge discovery too.
On this host the test runner also needs
`XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1`. The test uses an isolated
temporary Chrome profile and its own project, imports a synthetic video/audio
fixture, selects every preset in the UI at 100%, saves six MP4s and checks exact
dimensions, duration, H.264 video, AAC audio, and actual black padding pixels.
It prints its temporary artifact directory and keeps outputs/screenshots there.
It never opens or modifies the desktop editor's user profile.

Verified on 2026-09-20: 4 Rust tests, 20 export tests, TypeScript, production build,
and six actual UI exports. The existing Spongebob GTA project was inspected only.
Successful UI-export artifacts, screenshots and pixel checks for this run are in
`/tmp/opencut-instagram-test-Q7jnjf` (temporary files, not durable fixtures).

Deployment uses `.next-brand-instagram-20260920`; the prior
`.next-brand-agent-live-20260915` build is retained for rollback. The running
desktop window needs a refresh to load the new UI.
