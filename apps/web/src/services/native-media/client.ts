import type { StreamTargetChunk } from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import type { ExportBitrateMode } from "@/export";

export interface NativeMediaHealth {
	available: boolean;
	ffmpegVersion: string;
	ffprobeVersion: string;
	h264Nvenc: boolean;
}

export interface NativeProxyMetadata {
	width: number;
	height: number;
	durationSeconds: number;
	sizeBytes: number;
	videoCodec: string;
	audioCodec: string | null;
	hardwareEncoded: boolean;
}

export interface NativeAudioClip {
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	rate: number;
	maintainPitch: boolean;
	volume: number;
}

export interface NativeAudioExportSpec {
	durationSeconds: number;
	sampleRate: number;
	clips: NativeAudioClip[];
}

export interface NativeVideoFrameSink {
	add({
		canvas,
		timestampSeconds,
		durationSeconds,
	}: {
		canvas: HTMLCanvasElement | OffscreenCanvas;
		timestampSeconds: number;
		durationSeconds: number;
	}): Promise<void>;
	close(): Promise<void>;
	cancel(): Promise<void>;
}

let healthPromise: Promise<NativeMediaHealth | null> | null = null;
const NATIVE_FRAME_BATCH_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseNativeMediaHealth(value: unknown): NativeMediaHealth | null {
	if (
		!isRecord(value) ||
		value.available !== true ||
		typeof value.ffmpegVersion !== "string" ||
		typeof value.ffprobeVersion !== "string" ||
		typeof value.h264Nvenc !== "boolean"
	) {
		return null;
	}
	return {
		available: true,
		ffmpegVersion: value.ffmpegVersion,
		ffprobeVersion: value.ffprobeVersion,
		h264Nvenc: value.h264Nvenc,
	};
}

function parseNativeProxyMetadata(value: unknown): NativeProxyMetadata {
	if (
		!isRecord(value) ||
		typeof value.width !== "number" ||
		typeof value.height !== "number" ||
		typeof value.durationSeconds !== "number" ||
		typeof value.sizeBytes !== "number" ||
		typeof value.videoCodec !== "string" ||
		!(typeof value.audioCodec === "string" || value.audioCodec === null) ||
		typeof value.hardwareEncoded !== "boolean"
	) {
		throw new Error("Proxy metadata is invalid");
	}
	return {
		width: value.width,
		height: value.height,
		durationSeconds: value.durationSeconds,
		sizeBytes: value.sizeBytes,
		videoCodec: value.videoCodec,
		audioCodec: value.audioCodec,
		hardwareEncoded: value.hardwareEncoded,
	};
}

async function readError(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "string"
		) {
			return body.error;
		}
	} catch {
		// The status text below is the fallback for non-JSON error bodies.
	}
	return `${response.status} ${response.statusText}`;
}

async function expectOk({
	response,
	operation,
}: {
	response: Response;
	operation: string;
}): Promise<Response> {
	if (response.ok) return response;
	throw new Error(`${operation} failed: ${await readError(response)}`);
}

export async function getNativeMediaHealth({
	refresh = false,
}: {
	refresh?: boolean;
} = {}): Promise<NativeMediaHealth | null> {
	if (refresh) healthPromise = null;
	if (!healthPromise) {
		healthPromise = fetch("/api/native-media/health", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) return null;
				return parseNativeMediaHealth(await response.json());
			})
			.catch(() => null);
	}
	return await healthPromise;
}

export async function generateNativeProxy({
	file,
}: {
	file: File;
}): Promise<{ response: Response; metadata: NativeProxyMetadata }> {
	const response = await expectOk({
		response: await fetch("/api/native-media/proxy", {
			method: "POST",
			headers: { "X-OpenCut-Filename": file.name },
			body: file,
		}),
		operation: "Proxy generation",
	});
	const encodedMetadata = response.headers.get("x-opencut-proxy-metadata");
	if (!encodedMetadata) throw new Error("Proxy metadata is missing");
	const rawMetadata: unknown = JSON.parse(decodeURIComponent(encodedMetadata));
	const metadata = parseNativeProxyMetadata(rawMetadata);
	return { response, metadata };
}

export class NativeExportSession {
	private constructor(private readonly sessionId: string) {}

	static async start(): Promise<NativeExportSession> {
		const response = await expectOk({
			response: await fetch("/api/native-media/export/start", {
				method: "POST",
			}),
			operation: "Native export startup",
		});
		const body: unknown = await response.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("sessionId" in body) ||
			typeof body.sessionId !== "string"
		) {
			throw new Error("Native export session ID is missing");
		}
		return new NativeExportSession(body.sessionId);
	}

	createVideoDestination(): WritableStream<StreamTargetChunk> {
		return new WritableStream<StreamTargetChunk>({
			write: async (chunk) => {
				await expectOk({
					response: await fetch(
						`/api/native-media/export/${this.sessionId}/video`,
						{
							method: "PUT",
							headers: {
								"Content-Type": "application/octet-stream",
								"X-OpenCut-Offset": String(chunk.position),
							},
							body: chunk.data,
						},
					),
					operation: "Native video upload",
				});
			},
			abort: async () => this.cancel(),
		});
	}

	createNvencVideoSink({
		width,
		height,
		fps,
		bitrate,
		bitrateMode,
	}: {
		width: number;
		height: number;
		fps: FrameRate;
		bitrate: number;
		bitrateMode: ExportBitrateMode;
	}): NativeVideoFrameSink {
		const endpoint = `/api/native-media/export/${this.sessionId}/raw-video`;
		const startRequest = fetch(endpoint, {
			method: "POST",
			headers: {
				"X-OpenCut-Width": String(width),
				"X-OpenCut-Height": String(height),
				"X-OpenCut-Fps-Numerator": String(fps.numerator),
				"X-OpenCut-Fps-Denominator": String(fps.denominator),
				"X-OpenCut-Video-Bitrate": String(bitrate),
				"X-OpenCut-Bitrate-Mode": bitrateMode,
			},
		}).then(async (response) =>
			expectOk({ response, operation: "Native NVENC startup" }),
		);
		let pendingFrames: ArrayBuffer[] = [];
		let pendingBytes = 0;
		let closed = false;
		const flush = async () => {
			if (pendingFrames.length === 0) return;
			await startRequest;
			const body = new Blob(pendingFrames, {
				type: "application/octet-stream",
			});
			pendingFrames = [];
			pendingBytes = 0;
			await expectOk({
				response: await fetch(endpoint, { method: "PUT", body }),
				operation: "Native NVENC frame batch",
			});
		};
		return {
			add: async ({ canvas, timestampSeconds, durationSeconds }) => {
				if (closed) throw new Error("Native video stream is closed");
				const frame = new VideoFrame(canvas, {
					timestamp: Math.round(timestampSeconds * 1_000_000),
					duration: Math.round(durationSeconds * 1_000_000),
				});
				try {
					const copyOptions: VideoFrameCopyToOptions = { format: "BGRA" };
					const bytes = new Uint8Array(frame.allocationSize(copyOptions));
					await frame.copyTo(bytes, copyOptions);
					pendingFrames.push(bytes.buffer);
					pendingBytes += bytes.byteLength;
					if (pendingBytes >= NATIVE_FRAME_BATCH_BYTES) await flush();
				} finally {
					frame.close();
				}
			},
			close: async () => {
				if (closed) return;
				closed = true;
				await flush();
				await expectOk({
					response: await fetch(endpoint, { method: "PATCH" }),
					operation: "Native NVENC finalization",
				});
			},
			cancel: async () => {
				if (closed) return;
				closed = true;
				pendingFrames = [];
				pendingBytes = 0;
				await startRequest.catch(() => undefined);
				await fetch(endpoint, { method: "DELETE" }).catch(() => undefined);
			},
		};
	}

	async finalize({
		spec,
		videoTranscode,
	}: {
		spec: NativeAudioExportSpec | null;
		videoTranscode?: {
			fps: FrameRate;
			bitrate: number;
			bitrateMode: ExportBitrateMode;
		};
	}): Promise<Response> {
		const sourceIds = new Map<string, string>();
		for (const clip of spec?.clips ?? []) {
			if (sourceIds.has(clip.sourceKey)) continue;
			const sourceId = `s${sourceIds.size}`;
			sourceIds.set(clip.sourceKey, sourceId);
			await expectOk({
				response: await fetch(
					`/api/native-media/export/${this.sessionId}/source/${sourceId}`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/octet-stream" },
						body: clip.file,
					},
				),
				operation: "Native audio upload",
			});
		}

		return await expectOk({
			response: await fetch(
				`/api/native-media/export/${this.sessionId}/finalize`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(videoTranscode
							? {
									"X-OpenCut-Video-Bitrate": String(videoTranscode.bitrate),
									"X-OpenCut-Bitrate-Mode": videoTranscode.bitrateMode,
									"X-OpenCut-Fps-Numerator": String(
										videoTranscode.fps.numerator,
									),
									"X-OpenCut-Fps-Denominator": String(
										videoTranscode.fps.denominator,
									),
								}
							: {}),
					},
					body: JSON.stringify(
						spec
							? {
									durationSeconds: spec.durationSeconds,
									sampleRate: spec.sampleRate,
									clips: spec.clips.map(
										({ sourceKey, file: _file, ...clip }) => ({
											...clip,
											sourceId: sourceIds.get(sourceKey),
										}),
									),
								}
							: null,
					),
				},
			),
			operation: "Native export finalization",
		});
	}

	async cancel(): Promise<void> {
		await fetch(`/api/native-media/export/${this.sessionId}`, {
			method: "DELETE",
		}).catch(() => undefined);
	}
}
