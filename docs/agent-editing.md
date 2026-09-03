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
analysis, return visual contact sheets, and apply a reviewed cut plan as one
undoable command.

## CLI

```sh
bun apps/agent/src/cli.ts projects
bun apps/agent/src/cli.ts inspect --project <project-id>
bun apps/agent/src/cli.ts stage-media --project <project-id> --media <media-id>
```

Generate a verbatim transcript to identify candidate words. Raw Whisper word
timestamps are search hints only; they must never be used directly as edit
boundaries.

```sh
bunx hyperframes@0.8.27 transcribe <audio-or-video> \
  --engine whisper --model small.en --language en --json
```

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
- `apply_cut_plan`

`apply_cut_plan` requires an exact revision and is marked as a destructive,
non-idempotent MCP tool. The server instructions require inspection and a
reviewed plan before use.

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
