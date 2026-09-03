import { describe, expect, test } from "bun:test";
import {
	analyzeFillerBoundaries,
	type AlignmentPass,
	type PcmAudio,
} from "./forced-alignment";

function pass({
	start,
	end,
	score = 0.8,
}: {
	start: number;
	end: number;
	score?: number;
}): AlignmentPass {
	return {
		path: `pass-${start}`,
		words: [
			{ word: "before", start: 0.8, end: 1.1, score: 0.9 },
			{ word: "uh,", start, end, score },
			{ word: "after", start: 2, end: 2.3, score: 0.9 },
		],
	};
}

function syntheticAudio(): PcmAudio {
	const sampleRate = 1_000;
	const samples = new Float32Array(sampleRate * 4);
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = index % 2 === 0 ? 0.001 : -0.001;
	}
	for (const [start, end] of [
		[0.8, 1.1],
		[1.4, 1.7],
		[2, 2.3],
	] as const) {
		for (let index = start * sampleRate; index < end * sampleRate; index += 1) {
			samples[index] = index % 2 === 0 ? 0.2 : -0.2;
		}
	}
	return { sampleRate, samples };
}

describe("analyzeFillerBoundaries", () => {
	test("uses consensus to find a complete speech island and quiet frame boundaries", () => {
		const [candidate] = analyzeFillerBoundaries({
			passes: [
				pass({ start: 1.35, end: 1.65 }),
				pass({ start: 1.36, end: 1.66 }),
				pass({ start: 1.34, end: 1.65 }),
			],
			audio: syntheticAudio(),
			fps: 50,
			sourceOriginSeconds: 0,
		});

		expect(candidate).toEqual(
			expect.objectContaining({
				accepted: true,
				alignedStart: 1.34,
				start: 1.14,
				end: 1.96,
			}),
		);
		expect(candidate?.speechStart).toBeCloseTo(1.4, 1);
		expect(candidate?.speechEnd).toBeCloseTo(1.7, 1);
	});

	test("rejects a filler when alignment passes do not agree", () => {
		const [candidate] = analyzeFillerBoundaries({
			passes: [
				pass({ start: 1.35, end: 1.55 }),
				pass({ start: 1.7, end: 1.9 }),
				pass({ start: 2.1, end: 2.3 }),
			],
			audio: syntheticAudio(),
			fps: 50,
			sourceOriginSeconds: 0,
		});

		expect(candidate?.accepted).toBe(false);
		expect(candidate?.rejectionReason).toBe(
			"alignment passes did not agree on the filler end",
		);
	});
});
