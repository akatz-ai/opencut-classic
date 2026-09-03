import { describe, expect, test } from "bun:test";
import { buildStreamingWaveformSummary } from "@/media/waveform-summary";

function audioChunk({
	sampleRate = 48_000,
	channels,
}: {
	sampleRate?: number;
	channels: number[][];
}): AudioBuffer {
	const data = channels.map((channel) => Float32Array.from(channel));
	return {
		sampleRate,
		numberOfChannels: data.length,
		length: data[0]?.length ?? 0,
		getChannelData: (channel: number) => data[channel],
	} as AudioBuffer;
}

async function* chunks(values: AudioBuffer[]): AsyncGenerator<AudioBuffer> {
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
