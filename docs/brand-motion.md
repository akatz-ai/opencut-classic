# Akatz brand graphics and transitions

First implementation slice, verified 2026-09-15. This extends OpenCut Classic;
it is not a separate compositor application or an After Effects replacement.

## Using it

- **Brand Kit:** add a bold arrow, curved arrow, double chevron, technical card,
  focus brackets, or scene pin. Every asset is a native editable graphic; its
  fill, accent and outline remain editable/keyframable in Properties.
- Palette buttons apply a brand fill to selected graphics or text. The palette
  follows the supplied brand sheet, not colors sampled from the thumbnail.
- Each **SVG ↓** button downloads actual vector paths on a transparent canvas.
  Canvas rendering and SVG downloads share one geometry definition.
- **Explain card** and **Input → Result** insert five-second layouts at the
  playhead with live text and pop-in/fade-out animation. One undo removes the
  whole insertion. These are independent layers, not nested/grouped clips or
  media-replacement slots. Default typography uses Arial; no brand font is
  silently downloaded or licensed on the user's behalf.
- **Transitions:** select visual clips, choose Entrance, Exit, or Between clips,
  set duration/easing, and click a preset. Fade, four slide directions, and pop
  are available. Select the corresponding edge to remove it. Timeline IN/OUT
  badges indicate applied transitions.

## Transition semantics

Timing and easing live in `rust/crates/motion`, exposed by the local WASM
package. The same resolver applies motion in preview, snapshots and export.
Existing transform/opacity keyframes are preserved; motion adds translation
and multiplies scale/opacity. Evaluating a frame does not depend on playback
history, so seeking backwards is deterministic.

Between-clips transitions start at the existing edit point. The incoming clip
reveals itself over actual post-roll from the outgoing clip; the edit positions,
project duration and audio timing do not change. This requires adjacent
video/image clips on the same visible track. An outgoing video needs sufficient
unused source footage after its trim, accounting for speed. The outgoing clip
must not have a conflicting exit transition. Images can hold without a video
source handle. Slides are slide-over reveals, not two-picture pushes.

There is no freeze-frame substitution and no automatic audio crossfade. If a
later edit invalidates a transition, the assets panel displays an actionable
warning, preview temporarily disables the invalid motion, and export blocks
instead of silently producing a different result. Shortening a clip fits its
edge durations proportionally. Split and native cut operations preserve only
the surviving original edge effects, not duplicate entrances at internal cuts.

Native graphics are rasterized for compositing at a size appropriate to their
output footprint, in 128-pixel buckets with an 8192-pixel cap. Definitions keep
their existing 512-unit coordinate system, preserving stroke width semantics.
The downloaded SVGs themselves remain resolution-independent.

## Build and verification

The web app now always resolves the workspace WASM package. Build Rust/WASM
before the web app; the published 0.2.10 package lacks the new motion exports.

```sh
bun run build:wasm
bun run build:web
bun run test
cargo test -p motion -p media
```

Verified on this workstation:

- 281 Bun tests passed, including seven new motion/render-tree/vector tests.
- 11 Rust motion/media tests passed, including source handles, easing, trimming,
  split lifecycle, and native cut lifecycle.
- TypeScript and production build passed. Feature-specific lint passed; a
  broader lint of touched files still reports the pre-existing anonymous icon
  component and update-pipeline cast rules.
- Isolated browser: six-layer layout insertion, six SVG downloads, undo/redo,
  transition controls, and persisted motion after reopening.
- Hardware browser backend: `BrowserWebGpu:Bgra8Unorm`. Real 1920×1080/30 fps
  export: 150 H.264 frames, exactly five seconds, intentionally silent.
- Separate red/blue timestamped-source test: real UI-applied half-second
  dissolve, 120 H.264 frames plus AAC-LC, exactly four seconds. The midpoint
  includes the outgoing source timestamp beyond its two-second visible trim,
  proving post-roll is moving footage. Both outputs fully decode with FFmpeg.
- The automated headless SwiftShader/WebGL export timed out waiting for GPU
  work. Hardware-backed export passed; software-GPU export is not claimed as
  verified by this change.

Local proof files and SVGs are retained in
`/home/akatz/Downloads/akatz-opencut-brand-kit-2026-09-15/`.

## Transition browser and timeline UX (2026-09-15)

The transition UI now follows CapCut's library/timeline/inspector separation:

- Left: six animated preview cards, search, Basic/Slide/Zoom filters, and a
  hover/focus add affordance. Between-clips is the default; In/Out remain
  separate placement modes for clip animations. Previews use original vector
  scenes and the shared Rust motion evaluator; reduced-motion is respected.
- Timeline: drop a card on the plus marker at a touching video/image cut;
  click its transition block to select it. Drag the block's right edge to change
  duration, with one undo entry per gesture. The block starts at the cut and
  extends into the incoming clip, matching our existing one-sided engine.
- Right: selected transition name/thumbnail, duration input and slider, easing,
  jump-to-start, change, and remove. Delete removes the selected transition,
  not its clip. Clicking the clip body restores clip properties.

No new effects or automatic source handles are implied. Existing footage-tail,
same-track adjacency, render/export validation, and unchanged-audio rules remain.
Native card drag/drop currently targets between-clips markers; In/Out use click
application. The normal clip trim handles are separate from the transition's
duration handle. Short blocks retain a minimum clickable width at low zoom.

Reference: https://www.capcut.com/resource/types-of-filmmaking-transitions
(desktop steps: categorized/searchable cards, hover preview, drop at a cut,
timeline resize and right-panel duration).

Verified with a private hardware-backed Chrome profile: six cards, preview
animation, category/search, native drag-to-cut, numeric/slider/resize edits,
single-step undo/redo, replacement preserving timing, transition-only Delete,
invalid-duration rejection, In animation, and persistence after reload. No
browser errors. Real four-second export fully decoded: 120 H.264 frames at
640x360/30 fps with AAC-LC. Browser evidence and reproducible fixture harness:
`/tmp/opencut-transition-cards-WvtLsb/`.

The complete Bun suite passes 287 tests, including six UI-adapter regression
tests for selection invalidation, mask-selection precedence, safe removal,
atomic validation, deleted targets, and supported drag payloads. TypeScript,
feature-specific lint, and the production build pass. The local service uses
`.next-transitions-preview-20260915` on port 3003 after the preview fix below.

## Same-source preview regression fixed (2026-09-15)

The first browser proof used two different source files. A real edit containing
two clips from one source exposed a decoder-cache bug: parallel render-node
requests shared one mutable decoder cursor/canvas pool, so the incoming request
superseded the outgoing one. Dissolves could show only the incoming image.

Video render nodes now carry a stable per-clip decode stream ID. Preview,
proxy playback, and export use independent cursors for separate clips, while
retaining the existing bounded LRU and media/proxy invalidation. Blur-background
nodes use their own stream IDs as well. No project-format change is required.

Browser pixel proof with a single red-then-blue video: before the fix, midpoint
RGB was `[30,71,234]` (only blue); after, `[136,60,131]` (a blend). Actual playback
also contains intermediate blends. Repeated with an automatically generated
preview proxy. Same-source H.264 export fully decodes and contains the blend.
291 tests pass, including new shared-source/proxy render-tree and cursor-key
regressions; TypeScript, targeted lint, and production build pass. Evidence:
`/tmp/opencut-transition-preview-4YSv9C/`.

## Color and effects usability (2026-09-15)

- **Effects** now has searchable, keyboard-accessible preview cards. Clicking
  applies to the selected visual clips, in one undoable batch, and opens their
  Effects inspector. Dragging a card still uses the existing timeline drop path.
- **Adjustment** opens the same library filtered to color. The explicit
  **Adjustment layer** mode inserts a timed effect above the footage at the
  playhead. It affects the composited layers below it; trim/move its timeline
  block to control the affected range.
- **Color adjustment** provides exposure in stops, contrast, saturation,
  temperature, and tint. Defaults are neutral. The shader and safety bounds
  live in Rust and are shared by preview and export. Temperature/tint are
  creative SDR controls, not calibrated Kelvin white balance, automatic shot
  matching, an HDR workflow, or a color-management system.
- Effect inspectors have numeric fields, live sliders, and a one-step Reset.
  Clip effects retain their bypass, remove, and reorder controls. Reset restores
  base parameter values without deleting existing animation/keyframes.
- Text layers now expose their existing clip-effect support in the inspector.
  Numeric fields and slider thumbs have accessible names.
- Focused sliders keep Home/End/arrow keys instead of triggering timeline
  navigation. Keyboard slider commits wait for their final preview update,
  preserving undo and exported values. Effect cards support Enter/Space.

The browser adjustment-layer test exposed an existing frame-contract mismatch:
`SceneEffect` expected Rust's `effect_pass_groups` instead of the browser's
`effectPassGroups`. The shared compositor now reads the browser spelling and
retains the old spelling as an alias, with serialization regression tests.

Export performance work remains deferred by request. This change does not
replace the existing export architecture or alter the AAC-LC requirement.
The preferred future investigation is profiling/optimizing the current WebGPU
path, once real projects justify that work.

Verification: 295 Bun tests, 21 Rust compositor/effects/motion/media tests,
TypeScript, feature-specific lint, and production build pass. A private
hardware-backed Chrome profile verifies neutral pixels, all five adjustments,
clip bypass/reset/remove, undo/redo, persistence, keyword search, keyboard
controls, two-clip batch application with one-step undo, clip drag/drop, and
adjustment layers. The original color fixture
samples `[131,98,62]`; desaturation samples `[104,104,104]`; bypass/reset return
exactly to the original. Real MP4 outputs preserve H.264 and AAC-LC and are
checked with FFmpeg. Reproducible browser harness and captures:
`/tmp/opencut-color-dItYzT/`. The local service on port 3003 now uses
`.next-brand-color-verified-20260915`; refresh the editor to load it.

## Still separate milestones

Nested compositions; saved user-defined templates/brand kits; presenter matte
generation and edge refinement; tracking and anchor binding; motion blur;
automatic color matching; shadow integration; audio buses/ducking/crossfades.
The scene pin is graphics only, not a tracker. The existing effect/mask tools
are not being represented as a new matting system.
