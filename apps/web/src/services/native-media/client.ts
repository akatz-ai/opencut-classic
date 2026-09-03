import type { StreamTargetChunk } from "mediabunny";

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

let healthPromise: Promise<NativeMediaHealth | null> | null = null;

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

	async finalize({
		spec,
	}: {
		spec: NativeAudioExportSpec;
	}): Promise<Response> {
		const sourceIds = new Map<string, string>();
		for (const clip of spec.clips) {
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
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						durationSeconds: spec.durationSeconds,
						sampleRate: spec.sampleRate,
						clips: spec.clips.map(({ sourceKey, file: _file, ...clip }) => ({
							...clip,
							sourceId: sourceIds.get(sourceKey),
						})),
					}),
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
