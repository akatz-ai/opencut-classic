import { describe, expect, test } from "bun:test";
import {
	buildStreamingWaveformSummary,
	buildStreamingWaveformSummaryFromSamples,
	type WaveformAudioBufferChunk,
} from "@/media/waveform-summary";
import { AudioSample } from "mediabunny";

function audioChunk({
	sampleRate = 48_000,
	channels,
}: {
	sampleRate?: number;
	channels: number[][];
}): WaveformAudioBufferChunk {
	const data = channels.map((channel) => Float32Array.from(channel));
	return {
		sampleRate,
		numberOfChannels: data.length,
		length: data[0]?.length ?? 0,
		getChannelData: (channel: number) => data[channel],
	};
}

async function* chunks(
	values: WaveformAudioBufferChunk[],
): AsyncGenerator<WaveformAudioBufferChunk> {
	for (const value of values) {
		yield value;
	}
}

describe("buildStreamingWaveformSummary", () => {
	test("keeps bucket boundaries continuous across decoded chunks", async () => {
		const summary = await buildStreamingWaveformSummary({
			sourceKey: "media:test",
			bucketSize: 4,
			chunks: chunks([
				audioChunk({ channels: [[0.1, -0.5], [0.2, 0.25]] }),
				audioChunk({ channels: [[0.3, 0.4, -0.9], [0.7, 0.1, 0.2]] }),
			]),
		});

		expect(summary.sourceKey).toBe("media:test");
		expect(summary.sampleRate).toBe(48_000);
		expect(summary.totalSamples).toBe(5);
		expect(summary.bucketSize).toBe(4);
		expect(summary.amplitudes[0]).toBeCloseTo(0.7);
		expect(summary.amplitudes[1]).toBeCloseTo(0.9);
	});

	test("returns a compact empty summary when a source yields no audio", async () => {
		const summary = await buildStreamingWaveformSummary({
			sourceKey: "media:silent",
			chunks: chunks([]),
		});

		expect(summary.sampleRate).toBe(0);
		expect(summary.totalSamples).toBe(0);
		expect(summary.amplitudes.length).toBe(0);
	});

	test("rejects inconsistent decoder sample rates", async () => {
		const promise = buildStreamingWaveformSummary({
			sourceKey: "media:mixed-rates",
			chunks: chunks([
				audioChunk({ sampleRate: 44_100, channels: [[0.1]] }),
				audioChunk({ sampleRate: 48_000, channels: [[0.2]] }),
			]),
		});

		await expect(promise).rejects.toThrow("sample rate changed");
	});
});

describe("buildStreamingWaveformSummaryFromSamples", () => {
	test("copies PCM into reusable arrays and closes every decoder sample", async () => {
		const first = new AudioSample({
			format: "f32-planar",
			data: Float32Array.from([0.1, -0.5, 0.2, 0.25]),
			numberOfChannels: 2,
			sampleRate: 48_000,
			timestamp: 0,
		});
		const second = new AudioSample({
			format: "f32-planar",
			data: Float32Array.from([0.3, 0.4, -0.9, 0.7, 0.1, 0.2]),
			numberOfChannels: 2,
			sampleRate: 48_000,
			timestamp: 2 / 48_000,
		});
		async function* samples() {
			yield first;
			yield second;
		}

		const summary = await buildStreamingWaveformSummaryFromSamples({
			sourceKey: "media:samples",
			bucketSize: 4,
			samples: samples(),
		});

		expect(summary.totalSamples).toBe(5);
		expect(summary.amplitudes[0]).toBeCloseTo(0.7);
		expect(summary.amplitudes[1]).toBeCloseTo(0.9);
		expect(() =>
			first.copyTo(new Float32Array(2), {
				planeIndex: 0,
				format: "f32-planar",
			}),
		).toThrow("closed");
		expect(() =>
			second.copyTo(new Float32Array(3), {
				planeIndex: 0,
				format: "f32-planar",
			}),
		).toThrow("closed");
	});
});
