import { describe, expect, test } from "bun:test";
import type { WrappedAudioBuffer } from "mediabunny";
import {
	playbackAudioBuffers,
	schedulePlaybackAudioBuffer,
} from "@/media/audio-playback-buffers";

const context: Pick<BaseAudioContext, "createBuffer" | "sampleRate"> = {
	sampleRate: 32_000,
	// eslint-disable-next-line opencut/prefer-object-params -- Match the Web Audio API.
	createBuffer(channels, length, sampleRate) {
		const data = Array.from(
			{ length: channels },
			() => new Float32Array(length),
		);
		return {
			numberOfChannels: channels,
			length,
			sampleRate,
			duration: length / sampleRate,
			getChannelData: (channel: number) => data[channel],
			// eslint-disable-next-line opencut/prefer-object-params -- Match the Web Audio API.
			copyToChannel: (source: Float32Array, channel: number, offset = 0) => {
				data[channel].set(source, offset);
			},
			// eslint-disable-next-line opencut/prefer-object-params -- Match the Web Audio API.
			copyFromChannel: (
				destination: Float32Array,
				channel: number,
				offset = 0,
			) => {
				destination.set(
					data[channel].subarray(offset, offset + destination.length),
				);
			},
		};
	},
};

// eslint-disable-next-line opencut/prefer-object-params -- Compact timestamp/PCM fixture tuples.
function chunk(timestamp: number, samples: number[], sampleRate = 32_000) {
	const buffer = context.createBuffer(2, samples.length, sampleRate);
	buffer.copyToChannel(Float32Array.from(samples), 0);
	buffer.copyToChannel(Float32Array.from(samples.map((v) => -v)), 1);
	return { buffer, timestamp, duration: buffer.duration };
}

async function* source(values: WrappedAudioBuffer[]) {
	yield* values;
}

describe("Web Audio playback packet boundaries", () => {
	test("shares exact output edges at non-integer playback rates and preserves phase", () => {
		const calls: number[][] = [];
		const node = {
			start: (...args: number[]) => {
				calls.push(args);
			},
			stop: (...args: number[]) => {
				calls.push(args);
			},
		};
		for (let i = 0; i < 2; i++) {
			expect(
				schedulePlaybackAudioBuffer({
					context: { currentTime: 0, sampleRate: 48_000 },
					node,
					startTime: (i * 0.032) / 5,
					duration: 0.032,
					offsetSeconds: 0.016,
					rate: 5,
				}),
			).toBe(true);
		}
		expect(calls[1][0]).toBe(calls[2][0]);
		expect(calls[2][1]).toBeCloseTo(0.016 + (308 / 48_000 - 0.032 / 5) * 5, 12);
	});

	test("late packets skip source time at playback rate and expired packets never start", () => {
		const calls: number[][] = [];
		const node = {
			start: (...args: number[]) => {
				calls.push(args);
			},
			stop: (...args: number[]) => {
				calls.push(args);
			},
		};
		expect(
			schedulePlaybackAudioBuffer({
				context: { currentTime: 0.01, sampleRate: 48_000 },
				node,
				startTime: 0,
				duration: 0.032,
				offsetSeconds: 0.016,
				rate: 2,
			}),
		).toBe(true);
		expect(calls[0][1]).toBeCloseTo(0.036, 12);
		expect(calls[1][0]).toBe(0.016);
		expect(
			schedulePlaybackAudioBuffer({
				context: { currentTime: 1, sampleRate: 48_000 },
				node,
				startTime: 0,
				duration: 0.032,
				offsetSeconds: 0.016,
				rate: 2,
			}),
		).toBe(false);
		expect(calls).toHaveLength(2);
	});
	test("includes adjacent PCM but preserves original timestamps and audible spans", async () => {
		const chunks = [
			chunk(0, [1, 2]),
			chunk(2 / 32_000, [3, 4]),
			chunk(4 / 32_000, [5, 6]),
		];
		const result = await Array.fromAsync(
			playbackAudioBuffers({ chunks: source(chunks), context }),
		);
		expect(result.map((c) => Array.from(c.buffer.getChannelData(0)))).toEqual([
			[1, 2, 3, 4],
			[1, 2, 3, 4, 5, 6],
			[3, 4, 5, 6],
		]);
		expect(Array.from(result[1].buffer.getChannelData(1))).toEqual([
			-1, -2, -3, -4, -5, -6,
		]);
		expect(result.map((c) => c.timestamp)).toEqual(
			chunks.map((c) => c.timestamp),
		);
		expect(result.map((c) => c.duration)).toEqual(
			chunks.map((c) => c.duration),
		);
		expect(result.map((c) => c.offsetSeconds)).toEqual([
			0,
			2 / 32_000,
			2 / 32_000,
		]);
		expect(Array.from(chunks[1].buffer.getChannelData(0))).toEqual([3, 4]);
	});

	test("does not bridge genuine gaps or changes in sample rate", async () => {
		const chunks = [
			chunk(0, [1]),
			chunk(1, [2]),
			chunk(1 + 1 / 32_000, [3], 48_000),
		];
		const result = await Array.fromAsync(
			playbackAudioBuffers({ chunks: source(chunks), context }),
		);
		expect(result.map((c) => Array.from(c.buffer.getChannelData(0)))).toEqual([
			[1],
			[2],
			[3],
		]);
		expect(result.map((c) => c.sampleRateRatio)).toEqual([1, 1, 1.5]);
		expect(result.map((c) => c.offsetSeconds)).toEqual([0, 0, 0]);
	});

	test("bounds padding and decoder lookahead and closes the decoder on cancellation", async () => {
		let decoded = 0;
		let closed = false;
		async function* decoder() {
			try {
				for (let i = 0; i < 1000; i++) {
					decoded++;
					yield chunk((i * 1024) / 32_000, Array(1024).fill(i));
				}
			} finally {
				closed = true;
			}
		}
		const iterator = playbackAudioBuffers({ chunks: decoder(), context });
		const first = await iterator.next();
		expect(decoded).toBe(2);
		expect(first.value?.buffer.length).toBe(1536);
		const second = await iterator.next();
		expect(decoded).toBe(3);
		expect(second.value?.buffer.length).toBe(2048);
		await iterator.return();
		expect(closed).toBe(true);
		expect(decoded).toBe(3);
	});

	test("handles empty and single-packet audio", async () => {
		expect(
			await Array.fromAsync(
				playbackAudioBuffers({ chunks: source([]), context }),
			),
		).toEqual([]);
		const only = chunk(0, [1]);
		const result = await Array.fromAsync(
			playbackAudioBuffers({ chunks: source([only]), context }),
		);
		expect(result).toEqual([{ ...only, offsetSeconds: 0, sampleRateRatio: 1 }]);
	});
});
