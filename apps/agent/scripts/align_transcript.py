#!/usr/bin/env python3
"""Force-align an approximate Whisper transcript to 16 kHz mono audio.

This deliberately treats ASR timestamps as coarse search windows. Word boundaries
come from WhisperX's wav2vec2 CTC aligner and include alignment confidence.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import soundfile
import torch
import whisperx


def word_timing(entry: dict[str, Any]) -> tuple[float, float] | None:
    if isinstance(entry.get("start"), (int, float)) and isinstance(
        entry.get("end"), (int, float)
    ):
        return float(entry["start"]), float(entry["end"])
    offsets = entry.get("offsets")
    if (
        isinstance(offsets, dict)
        and isinstance(offsets.get("from"), (int, float))
        and isinstance(offsets.get("to"), (int, float))
    ):
        return float(offsets["from"]) / 1000, float(offsets["to"]) / 1000
    return None


def read_words(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text())
    if isinstance(value, list):
        candidates = value
    elif isinstance(value, dict):
        candidates = value.get("transcription", [])
    else:
        candidates = []
    words: list[dict[str, Any]] = []
    for entry in candidates:
        if not isinstance(entry, dict) or not isinstance(entry.get("text"), str):
            continue
        timing = word_timing(entry)
        if timing is None or not entry["text"].strip():
            continue
        words.append({"text": entry["text"], "start": timing[0], "end": timing[1]})
    if not words:
        raise ValueError("Transcript did not contain timed words")
    return words


def coarse_segments(
    words: list[dict[str, Any]], duration: float, target_seconds: float, padding: float
) -> list[dict[str, Any]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for word in words:
        current.append(word)
        elapsed = word["end"] - current[0]["start"]
        is_sentence_end = word["text"].rstrip().endswith((".", "?", "!"))
        if (
            elapsed >= target_seconds and is_sentence_end
        ) or elapsed >= target_seconds + 5:
            groups.append(current)
            current = []
    if current:
        groups.append(current)

    segments: list[dict[str, Any]] = []
    for group in groups:
        segments.append(
            {
                "start": max(0.0, group[0]["start"] - padding),
                "end": min(duration, group[-1]["end"] + padding),
                "text": "".join(word["text"] for word in group).strip(),
            }
        )
    return segments


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--transcript", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--chunk-seconds", type=float, default=25.0)
    parser.add_argument("--padding-seconds", type=float, default=1.25)
    args = parser.parse_args()

    audio, sample_rate = soundfile.read(args.audio, dtype="float32", always_2d=False)
    if sample_rate != 16_000 or audio.ndim != 1:
        raise ValueError("Alignment audio must be 16 kHz mono")
    duration = len(audio) / sample_rate
    words = read_words(args.transcript)
    segments = coarse_segments(
        words, duration, args.chunk_seconds, args.padding_seconds
    )

    model, metadata = whisperx.load_align_model(
        language_code="en",
        device=args.device,
        model_name=args.model,
        model_cache_only=True,
    )
    result = whisperx.align(
        segments,
        model,
        metadata,
        torch.from_numpy(audio),
        args.device,
        return_char_alignments=True,
    )
    payload = {
        "schemaVersion": 1,
        "method": "whisperx-wav2vec2-ctc",
        "model": args.model,
        "audio": str(args.audio),
        "durationSeconds": duration,
        "coarseSegments": segments,
        "segments": result["segments"],
        "words": result["word_segments"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
