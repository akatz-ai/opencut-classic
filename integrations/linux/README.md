# Dolphin / Open With integration

Installed on akatz-arch on 2026-09-08. This is local Linux/browser integration, not a new rendering or editing backend.

## User contract

- Right-click a video → **Open With → OpenCut** (first alternative).
- Every launch creates a fresh project named with the browser's current local date/time (including milliseconds) and imports just that clip into the media library. The original filename stays on the media asset. Existing project names are not changed.
- The timeline stays empty. Existing projects/windows are not reused or cleared.
- Double-click and the primary Open action remain **mpv**. No `[Default Applications]` entries were changed.
- MP4, MPEG, MOV, MKV and WebM are registered. Container/codec support is still governed by OpenCut's existing import pipeline; this does not promise every codec will decode.

KDE places the preferred application in the main context menu and the remaining offers in the Open With submenu. The installed menu was inspected using the actual `KFileItemActions` implementation: mpv stayed at top level, with OpenCut then LosslessCut in the submenu. See [KDE's implementation](https://invent.kde.org/frameworks/kio/-/blob/master/src/widgets/kfileitemactions.cpp).

## Installed pieces

- Desktop entry: `/home/akatz/.local/share/applications/chrome-dhnnofhinenpbiicikinpebbpkinbhnm-Default.desktop`, using `Exec=/home/akatz/.local/bin/opencut-classic-launch %F`.
- Launcher: `/home/akatz/.local/bin/opencut-classic-launch`. Bare launch keeps the installed Chrome app behavior; file arguments call `integrations/linux/open-file.ts` with Bun.
- User service: `opencut-classic-local-web.service`, with a persistent definition under `/home/akatz/.config/systemd/user/` and a `local-files.conf` drop-in. File launch starts the service on demand; no new login autostart was enabled.
- Server opt-in: `OPENCUT_LOCAL_FILES=1`. Current isolated production build: `.next-open-local-20260908-r5`, selected by `OPENCUT_NEXT_DIST_DIR`.
- Local build uses `NEXT_PUBLIC_OPENCUT_LOCAL_FILES=1` to disable analytics collection on the file-handoff page and local editor.
- MIME ordering: only `[Added Associations]` in `/home/akatz/.config/mimeapps.list`. The original default section is byte-for-byte unchanged.
- Original desktop configuration/launcher backups: `/home/akatz/.local/state/opencut/file-open-backup-20260908/`.

## Handoff and safety

The desktop launcher creates a random, 30-minute ticket in an owner-only `~/.local/state/opencut/local-open/` directory. It opens a separate Chrome app window in the existing OpenCut profile with only the opaque ticket in the URL fragment. An opt-in, loopback/same-origin API returns only the exact selected file after checking its identity, size and timestamp. There is no HTTP endpoint accepting arbitrary local paths. Tickets are deleted after successful import; original videos are never deleted or modified.

The frontend uses existing project creation, media processing and storage APIs. It records the in-progress project in session storage, avoids duplicate StrictMode imports, supports retry after reload, and never inserts a timeline element. After saving, it navigates to the new editor project.

The origin check uses the browser's validated loopback Host header because Next may construct an internal request URL using `localhost` for a browser request made to `127.0.0.1`. This mismatch was caught by the live test and is covered by a regression test.

## Validation

From `apps/web`:

```sh
bun test src/server/local-open/tickets.test.ts
```

Seven tests cover private metadata, literal filenames containing spaces/quotes/Unicode/shell characters, fresh independent tickets, unsupported/empty/missing files, expired tickets, changed files, symlinks, opt-in enablement and cross-origin rejection. Changed-file lint and a production build passed.

Live checks used a real H.264/AAC MP4 with a spaced Unicode filename, the installed desktop launcher and KDE's actual Open With action. Each successful launch produced a distinct saved project containing one media asset and zero timeline elements. Existing project revisions remained unchanged. Desktop entry validation, Bash syntax validation, and the KDE application menu/default check passed.

For future builds, use a fresh `OPENCUT_NEXT_DIST_DIR` so compilation does not overwrite the live build. Preserve old static chunks for already-open editor windows and update both the persistent service and its drop-in to the new build before a scoped restart. Do not restart Chrome or alter MIME defaults to deploy this feature.

## Preview audio incident, 2026-09-08

On akatz-arch, a 10.125-second H.264/AAC clip (32 kHz stereo audio) played in mpv but was silent in an existing OpenCut Chrome app window. Track/source audio was enabled, preview volume was 1, and its running AudioContext scheduled decoded buffers with an analyser peak around 0.248. Preview audio reads the original media, not the silent video proxy. An isolated Chrome profile played the same source successfully.

The affected profile's three-day-old Chrome AudioService process had no PulseAudio/PipeWire client or sink input. Suspending/resuming and then recreating the AudioContext did not restore output. After verifying the helper's parent and dedicated OpenCut profile, terminating only that audio helper allowed Chrome to respawn it and reconnect to the Arctis stereo-game output. A `parec --monitor-stream` recording restricted to the recovered OpenCut sink input measured mean -15.6 dB and maximum -0.5 dB. Editor windows remained open, the playhead was restored, and no timeline/media edits or decoder changes were made. The cause of the original audio-service disconnection was not established.

For a recurrence, first inspect source/track/master mute state, decoded audio signal, and the exact profile's system stream. Do not kill all Chrome processes or restart PipeWire as a first response. A targeted audio-helper restart requires fresh process/profile ownership checks; historical process IDs must never be reused.

The timestamp update was tested through a fresh live file handoff: `2026-09-08 18:59:40,034`, one media asset, zero timeline elements. Production build, TypeScript validation, and all seven ticket tests passed. Test browser data was isolated from the user's OpenCut profile.

## Preview crackle fix, 2026-09-08

After output recovery, the user confirmed sound but reported crackling absent in mpv. The source's 317 AAC packets were contiguous (1024 samples each at 32 kHz), with no timestamp gaps. Playing each decoded packet through an independent Web Audio buffer source at a 48 kHz output introduced resampler edge transients. In a real Chrome OfflineAudioContext comparison against one continuous buffer, the original source had peak sample error 0.637 and RMS error 0.00402, concentrated at packet edges rather than the interior. This was separate from the disconnected audio helper.

`audio-playback-buffers.ts` now carries up to 512 neighboring samples on each side with one-packet lookahead, schedules only the original audible span, and shares sample-accurate start/stop edges. Buffer storage uses the output clock with an explicit source/output playback-rate ratio to preserve fractional source offsets (including 44.1 kHz input). No whole-file decode, source conversion, export changes, or project migration are required. The audio manager applies the ratio when scheduling, clips the final packet to the timeline clip end, and accounts for playback rate when catching up after a late packet.

Validation:

```sh
# From apps/web:
bun test src/media/__tests__/audio-playback-buffers.test.ts

# From repository root; set CHROME_BIN if Chrome is not on PATH:
CHROME_BIN=/opt/google/chrome/google-chrome bun integrations/linux/check-preview-audio.ts
```

Six unit tests cover adjacent PCM, source-clock ratios, genuine gaps/rate changes, bounded decoder lookahead, cancellation, exact output edges, and late packets. Thirty real-browser comparisons cover 32/44.1/48 kHz inputs, 0.5/1/1.5/2/5x rates, and start/mid-packet seeks; maximum sample error was below 0.000003 against continuous playback. Those comparisons exclude initial/final filter transients and use sample-aligned seeks to avoid the native reference's own fractional-offset rounding. Production build and TypeScript validation passed. New-file lint passed; the audio manager retains a pre-existing unsafe retime-mode assertion lint error and an empty-catch warning, outside this change.

The affected live editor was saved/reloaded into build r5 and observed scheduling padded 2048-sample buffers at 48 kHz with the expected 2/3 playback-rate ratio for the original 32 kHz source. Headphone output was present, and the user subsequently confirmed that the crackling was fixed. Both original editor windows and their media remained intact. Diagnostic artifacts for this session are under `/tmp/opencut-audio-check.w7bjAO/` (temporary, not a durable artifact store).
