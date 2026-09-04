# Agent editing

OpenCut Classic exposes its live browser-owned project through a loopback-only
agent bridge. The bridge never reads Chrome's IndexedDB or OPFS files from an
external process. The mounted editor publishes a structured snapshot and
executes revision-checked commands through `EditorCore`, preserving autosave and
undo behavior.

## Surfaces

- `apps/agent/src/cli.ts` is the JSON CLI.
- `apps/agent/src/mcp.ts` is the stdio MCP adapter over the same HTTP API.
- `apps/web/src/agent-bridge/client.tsx` publishes live state and applies
  commands inside the browser.
- `rust/crates/media/src/cuts.rs` owns cut normalization, clip splitting, trim
  adjustment, and global ripple logic.

The current tools can inspect projects, stage original or proxy media for local
analysis, return visual contact sheets, create reusable time-aligned
transcripts, apply a reviewed cut plan as one undoable command, and render a
revision-checked MP4 artifact.

## CLI

```sh
bun apps/agent/src/cli.ts projects
bun apps/agent/src/cli.ts inspect --project <project-id>
bun apps/agent/src/cli.ts stage-media --project <project-id> --media <media-id>
bun apps/agent/src/cli.ts transcribe-media --project <project-id>
```

Export the exact inspected revision with explicit output parameters:

```sh
bun apps/agent/src/cli.ts export-project \
  --project <project-id> \
  --expected-revision <revision> \
  --width 1920 --height 1080 --fps 30 \
  --video-bitrate 3000000 \
  --bitrate-mode variable \
  --encoder webcodecs \
  --filename project-export.mp4
```

`--bitrate-mode constant` adds the native NVENC finishing pass for predictable
size. `--encoder native_nvenc` selects the experimental raw BGRA-to-NVENC path;
WebCodecs is the measured-fast default. Add `--no-audio` only when a silent
artifact is intentional.

## Transcription for script review

`transcribe-media` defaults to the local HyperFrames 0.8.27 `whisper.cpp`
runner with `small.en`. The package is pinned in the agent workspace and model
files use HyperFrames' persistent cache, so later calls do not need to locate or
configure a model. If `--media` is omitted, the command selects the audible
asset with the greatest coverage on the current timeline.

```sh
bun apps/agent/src/cli.ts transcribe-media \
  --project <project-id> \
  --backend local \
  --model small.en \
  --language en \
  --detail segments
```

The durable artifact contains the complete source-media word array. Every tool
call also remaps those words through the current timeline clips, trims, cuts,
and retimes, so a cached source transcript still produces a current edited
script. Default `segments` output returns compact timestamped passages;
`--detail text` returns only the edited script and `--detail words` returns both
complete word arrays. `--force` refreshes the cached source transcript.

Artifacts are stored owner-only under
`~/.local/share/opencut-agent/projects/<project-id>/transcripts/`. On the Splat
Smith walkthrough, the first 700-second local run took about two minutes and
produced 1,916 source words; a cached call returned in 34 ms and mapped 1,877
currently visible words through 24 timeline clips.

An explicit remote option reuses Hyprwhspr's configured `rest-api` provider:

```sh
bun apps/agent/src/cli.ts transcribe-media \
  --project <project-id> \
  --backend hyprwhspr \
  --language en
```

The remote path reads the provider key only from Hyprwhspr's owner-only
credential store, converts speech to 16 kHz mono FLAC, chunks long media using
Hyprwhspr's configured limit, and requests word and segment timestamps. It does
not put credentials in arguments, logs, Git, or transcript artifacts. This
option uploads audio to the configured provider and may incur provider charges,
so MCP instructions keep the local backend as the default unless remote
transcription is explicitly requested.

Raw ASR timestamps are suitable for script review and navigation, but remain
search hints rather than destructive edit boundaries.

## Accurate speech-cut alignment

The accurate speech-cut path uses WhisperX's CTC aligner with the Apache-2.0
`facebook/wav2vec2-base-960h` model. A CPU-only analysis environment can be
prepared without adding Python packages to the editor runtime:

```sh
uv venv --python 3.12 <aligner-venv>
uv pip install --python <aligner-venv>/bin/python \
  --index-url https://download.pytorch.org/whl/cpu \
  torch==2.8.0 torchaudio==2.8.0
uv pip install --python <aligner-venv>/bin/python \
  numpy==2.5.2 pandas==3.0.5 transformers==5.16.1 nltk==3.10.3 soundfile==0.14.0
uv pip install --python <aligner-venv>/bin/python --no-deps \
  'git+https://github.com/m-bain/whisperX.git@3ccc17b8de34f305300f8a3fd3c9f76ba820c0d0'

hf download facebook/wav2vec2-base-960h \
  config.json feature_extractor_config.json preprocessor_config.json \
  tokenizer_config.json special_tokens_map.json vocab.json model.safetensors \
  --local-dir <alignment-model-dir>
```

Extract the microphone stream as 16 kHz mono PCM WAV. Run independent
alignments with different chunk boundaries so a chunk-edge error cannot become
an edit:

```sh
for chunk_seconds in 55 90 120; do
  <aligner-venv>/bin/python apps/agent/scripts/align_transcript.py \
    --audio mic.wav \
    --transcript transcript.json \
    --model <alignment-model-dir> \
    --output "alignment-${chunk_seconds}.json" \
    --device cpu \
    --chunk-seconds "$chunk_seconds"
done
```

Build a frame-aligned plan from at least two alignment passes:

```sh

bun apps/agent/src/cli.ts plan-speech-cuts \
  --project <project-id> \
  --media <media-id> \
  --media-path mic.wav \
  --transcript <transcript-json> \
  --alignment-pass alignment-55.json \
  --alignment-pass alignment-90.json \
  --alignment-pass alignment-120.json \
  --silence-plan <reviewed-source-silences-json> \
  --output cut-plan.json
```

Apply only against the revision recorded during inspection:

```sh
bun apps/agent/src/cli.ts apply-cuts \
  --project <project-id> \
  --plan cut-plan.json \
  --expected-revision <revision>
```

The planner clusters each filler's aligned ending across passes, expands to the
complete matching speech island in the microphone waveform, and accepts the
candidate only when a quiet video-frame boundary exists on both sides without
overlapping the neighboring aligned words. Ambiguous candidates stay in the
video and are recorded with a rejection reason. Reviewed dead-air ranges are
kept separate from automatically detected silence.

The cut planner then maps source timestamps through existing timeline trims and
retimes. Adjacent cuts are merged, and the Rust planner rejects animated
elements it cannot yet split faithfully.

## MCP

Codex can start the local adapter with:

```sh
codex mcp add opencut -- \
  /home/akatz/.bun/bin/bun \
  /home/akatz/dev/projects/opencut-classic/apps/agent/src/mcp.ts
```

The adapter exposes:

- `list_projects`
- `inspect_project`
- `stage_media`
- `media_contact_sheet`
- `transcribe_media`
- `apply_cut_plan`
- `export_project`

`apply_cut_plan` requires an exact revision and is marked as a destructive,
non-idempotent MCP tool. `export_project` also requires an exact revision but
does not mutate the project. `transcribe_media` creates a local cache but does
not mutate OpenCut; its `hyprwhspr` backend is the only mode that sends audio to
a remote service. The server instructions require inspection and a reviewed
plan before timeline edits.

## Current limits

- The OpenCut editor must be open for staging or mutation commands.
- Bridge state is live but the current filesystem queue is single-workstation
  infrastructure, not a remote multi-user service.
- Cut plans refuse affected elements with animations until animation slicing is
  implemented in Rust.
- Contact sheets inspect source/proxy timestamps. A future command should render
  the post-composite OpenCut frame for overlays, masks, and text.
- Speech edits are hard cuts. Short audio crossfades remain future work.
- Forced alignment currently runs as optional local analysis tooling rather
  than as a bundled desktop dependency.
- Automatic selection transcribes the single audible asset with the greatest
  timeline coverage. Projects with several independent speakers or overlapping
  audible assets should call the tool once per media ID; merged speaker-aware
  transcription is future work.
