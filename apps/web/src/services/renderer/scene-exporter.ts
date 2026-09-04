import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type {
	ExportBitrateMode,
	ExportDestination,
	ExportFormat,
	ExportQuality,
} from "@/export";
import type { NativeVideoFrameSink } from "@/services/native-media/client";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	outputWidth?: number;
	outputHeight?: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	destination?: ExportDestination;
	videoBitrate?: number;
	bitrateMode?: ExportBitrateMode;
	nativeVideoSink?: NativeVideoFrameSink;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

const STREAMING_EXPORT_CHUNK_SIZE_BYTES = 1024 * 1024;

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private encodingCanvas: OffscreenCanvas;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private destination?: ExportDestination;
	private videoBitrate?: number;
	private bitrateMode: ExportBitrateMode;
	private nativeVideoSink?: NativeVideoFrameSink;

	private isCancelled = false;

	constructor({
		width,
		height,
		outputWidth = width,
		outputHeight = height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		destination,
		videoBitrate,
		bitrateMode = "variable",
		nativeVideoSink,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			outputWidth,
			outputHeight,
			fps,
		});
		this.encodingCanvas = new OffscreenCanvas(outputWidth, outputHeight);

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.destination = destination;
		this.videoBitrate = videoBitrate;
		this.bitrateMode = bitrateMode;
		this.nativeVideoSink = nativeVideoSink;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<{ buffer?: ArrayBuffer; savedToFile: boolean } | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);
		if (this.nativeVideoSink) {
			return await this.exportNativeVideo({
				rootNode,
				frameCount,
				ticksPerFrame,
				fpsFloat,
			});
		}

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const target = this.destination
			? new StreamTarget(this.destination.writable, {
					chunked: true,
					chunkSize: STREAMING_EXPORT_CHUNK_SIZE_BYTES,
				})
			: new BufferTarget();
		const output = new Output({
			format: outputFormat,
			target,
		});

		// Encode from a stable 2D canvas rather than reading the WebGPU surface
		// directly. The copy synchronizes presentation and prevents WebCodecs from
		// racing an uninitialized/shared compositor texture under a tight export loop.
		const videoSource = new CanvasSource(this.encodingCanvas, {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: this.videoBitrate ?? qualityMap[this.quality],
			bitrateMode: this.bitrateMode,
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		try {
			await output.start();

			if (audioSource && this.audioBuffer) {
				await audioSource.add(this.audioBuffer);
				audioSource.close();
			}

			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					await output.cancel();
					this.emit("cancelled");
					return null;
				}

				const timeTicks = i * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				await this.renderer.renderToCanvas({
					node: rootNode,
					time: timeTicks,
					targetCanvas: this.encodingCanvas,
				});
				await videoSource.add(timeSeconds, 1 / fpsFloat);

				this.emit("progress", i / frameCount);
			}

			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			videoSource.close();
			await output.finalize();
			this.emit("progress", 1);

			const buffer =
				target instanceof BufferTarget
					? (target.buffer ?? undefined)
					: undefined;
			if (target instanceof BufferTarget && !buffer) {
				this.emit("error", new Error("Failed to export video"));
				return null;
			}

			if (buffer) {
				this.emit("complete", buffer);
			}
			return {
				buffer,
				savedToFile: target instanceof StreamTarget,
			};
		} catch (error) {
			// MediaBunny/WebCodecs may report encoder failures asynchronously. Always
			// cancel the output so its encoder and stream resources are released before
			// the caller offers a retry.
			await output.cancel().catch(() => undefined);
			throw error;
		}
	}

	private async exportNativeVideo({
		rootNode,
		frameCount,
		ticksPerFrame,
		fpsFloat,
	}: {
		rootNode: RootNode;
		frameCount: number;
		ticksPerFrame: number;
		fpsFloat: number;
	}): Promise<{ savedToFile: true } | null> {
		const sink = this.nativeVideoSink;
		if (!sink) throw new Error("Native video sink is unavailable");
		try {
			for (let index = 0; index < frameCount; index += 1) {
				if (this.isCancelled) {
					await sink.cancel();
					this.emit("cancelled");
					return null;
				}
				const timeTicks = index * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				await this.renderer.renderToCanvas({
					node: rootNode,
					time: timeTicks,
					targetCanvas: this.encodingCanvas,
				});
				await sink.add({
					canvas: this.encodingCanvas,
					timestampSeconds: timeSeconds,
					durationSeconds: 1 / fpsFloat,
				});
				this.emit("progress", index / frameCount);
			}
			await sink.close();
			this.emit("progress", 1);
			return { savedToFile: true };
		} catch (error) {
			await sink.cancel().catch(() => undefined);
			throw error;
		}
	}
}
