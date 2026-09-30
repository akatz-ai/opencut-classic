# Audio fade handles

Audio clips expose two small handles on the clip-volume line:

- Drag the left handle right to create a fade-in.
- Drag the right handle left to create a fade-out.
- A longer drag produces a longer linear-amplitude fade. Returning a handle to
  its edge removes that fade.
- While dragging, a tooltip shows the duration. Each completed drag is one undo
  step. `Escape` is not needed; pointer cancellation restores the old value.
- A focused handle also supports arrow keys in 0.05-second steps, Shift+arrow in
  0.5-second steps, Home to remove the fade, and End for a full-clip fade.

Fades are stored independently as `fadeInDuration` and `fadeOutDuration` timeline
ticks on audio elements. They multiply the existing static or keyframed volume,
so adding a handle fade never deletes or rewrites hand-authored keyframes. If the
two fades overlap, the quieter side wins. This yields a natural triangular
envelope when both span the entire clip.

The envelope is evaluated by the shared Rust `audio-envelope` crate and its WASM
bindings. Timeline waveforms, interactive playback, browser export, native audio
staging, and final AAC output all use the same effective-gain resolver. Resizing a
clip clamps fades to the new duration. A normal split retains the original fade-in
on the left piece and fade-out on the right piece without adding fades at the cut.

Verification on 2026-09-20 covered Rust unit tests, TypeScript timeline tests,
type-checking, lint, a production build, real pointer drags in an isolated Chrome
profile, undo/redo, persistence through the live agent snapshot, and an exported
four-second H.264/AAC MP4. The measured mean audio level was about -42 dB near
both ends and -21 dB in the middle, confirming that the rendered file contains
the fades. The browser smoke test is `apps/agent/test/audio-fades.mjs` and keeps
its temporary screenshot, project fixture, and rendered proof file under the
printed `/tmp/opencut-audio-fades-test-*` directory.
