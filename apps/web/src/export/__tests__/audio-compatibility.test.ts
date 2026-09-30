import { describe, expect, test } from "bun:test";
import { requireExportAudioCodec } from "../audio-codec";
import { receiveNativeExport } from "../receive-native-export";
import { timelineMixToWav } from "../native-audio";

describe("MP4 audio compatibility", () => {
	const options = {
		format: "mp4" as const,
		sampleRate: 48000,
		numberOfChannels: 2,
	};
	test("rejects unavailable AAC instead of substituting Opus", async () => {
		await expect(
			requireExportAudioCodec({
				...options,
				encoder: { isConfigSupported: async () => ({ supported: false }) },
			}),
		).rejects.toThrow("MP4 export requires AAC");
	});
	test("uses the same AAC-LC config and bitrate for probing and encoding", async () => {
		await expect(
			requireExportAudioCodec({
				...options,
				encoder: {
					isConfigSupported: async (config) => {
						expect(config).toEqual({
							codec: "mp4a.40.2",
							sampleRate: 48000,
							numberOfChannels: 2,
							bitrate: 192000,
						});
						return { supported: true };
					},
				},
			}),
		).resolves.toBe("aac");
	});
	test("propagates encoder failure without a codec fallback", async () => {
		await expect(
			requireExportAudioCodec({
				...options,
				encoder: {
					isConfigSupported: async () => {
						throw new Error("encoder failed");
					},
				},
			}),
		).rejects.toThrow("encoder failed");
	});
	test("WebM retains its explicitly selected Opus format", async () => {
		await expect(
			requireExportAudioCodec({
				...options,
				format: "webm",
				encoder: {
					isConfigSupported: async () => {
						throw new Error("must not probe AAC");
					},
				},
			}),
		).resolves.toBe("opus");
	});
	test("native output supports download without a save-file picker", async () => {
		const stream = new Blob([new Uint8Array([1, 2, 3])]).stream();
		const result = await receiveNativeExport({ stream });
		expect(result.savedToFile).toBe(false);
		expect(new Uint8Array(result.buffer!)).toEqual(new Uint8Array([1, 2, 3]));
	});
	test("native output writes sequential offsets to stream-only destinations", async () => {
		const chunks: unknown[] = [];
		const result = await receiveNativeExport({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2]));
					controller.enqueue(new Uint8Array([3]));
					controller.close();
				},
			}),
			destination: {
				writable: new WritableStream({
					write(chunk) {
						chunks.push(chunk);
					},
				}),
			},
		});
		expect(result.savedToFile).toBe(true);
		expect(chunks).toEqual([
			{ type: "write", position: 0, data: new Uint8Array([1, 2]) },
			{ type: "write", position: 2, data: new Uint8Array([3]) },
		]);
	});
	test("PCM staging preserves stereo sample order and varying gain", async () => {
		const buffer = {
			length: 3,
			sampleRate: 48000,
			numberOfChannels: 2,
			getChannelData: (channel: number) =>
				new Float32Array(channel ? [-1, -0.5, 0] : [1, 0.5, 0]),
		};
		const view = new DataView(await timelineMixToWav(buffer).arrayBuffer());
		expect(view.getUint32(40, true)).toBe(12);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(
			Array.from({ length: 6 }, (_, index) =>
				view.getInt16(44 + index * 2, true),
			),
		).toEqual([32767, -32768, 16384, -16384, 0, 0]);
	});
});
