import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";
import { LruCache } from "@/services/cache/lru-cache";
import { incrementCounter } from "@/diagnostics/render-perf";

const MAX_VIDEO_SINKS = 8;

interface VideoSinkData {
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

export class VideoCache {
	private sinks: LruCache<string, VideoSinkData>;
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();

	constructor({ maxSinks = MAX_VIDEO_SINKS }: { maxSinks?: number } = {}) {
		this.sinks = new LruCache({
			maxEntries: maxSinks,
			onEvict: (mediaId, sinkData) => {
				if (sinkData.iterator) {
					void sinkData.iterator.return();
				}
				sinkData.input.dispose();
				this.frameChain.delete(mediaId);
				this.seekGenerations.delete(mediaId);
			},
		});
	}

	async getFrameAt({
		mediaId,
		file,
		time,
		maxSourceSize,
	}: {
		mediaId: string;
		file: File;
		time: number;
		maxSourceSize?: number;
	}): Promise<WrappedCanvas | null> {
		const sinkKey = this.getSinkKey({ mediaId, maxSourceSize });
		incrementCounter({
			name: this.sinks.has(sinkKey)
				? "videoSinkCacheHit"
				: "videoSinkCacheMiss",
		});
		await this.ensureSink({
			mediaId: sinkKey,
			file,
			maxSourceSize,
		});

		const sinkData = this.sinks.get(sinkKey);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(sinkKey) ?? 0) + 1;
		this.seekGenerations.set(sinkKey, generation);

		const previous = this.frameChain.get(sinkKey) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(sinkKey) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			sinkKey,
			current.catch(() => {}),
		);
		return current;
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
		maxSourceSize,
	}: {
		mediaId: string;
		file: File;
		maxSourceSize?: number;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file, maxSourceSize });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
		maxSourceSize,
	}: {
		mediaId: string;
		file: File;
		maxSourceSize?: number;
	}): Promise<void> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sourceWidth = videoTrack.displayWidth;
			const sourceHeight = videoTrack.displayHeight;
			const sourceLongSide = Math.max(sourceWidth, sourceHeight);
			const scale = maxSourceSize
				? Math.min(1, maxSourceSize / sourceLongSide)
				: 1;
			const targetWidth = Math.max(2, Math.round(sourceWidth * scale));
			const targetHeight = Math.max(2, Math.round(sourceHeight * scale));
			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
				width: targetWidth,
				height: targetHeight,
			});

			this.sinks.set({
				key: mediaId,
				value: {
					input,
					sink,
					iterator: null,
					currentFrame: null,
					nextFrame: null,
					lastTime: -1,
					prefetching: false,
					prefetchPromise: null,
				},
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		for (const key of Array.from(this.sinks.keys())) {
			if (
				key === mediaId ||
				key.startsWith(`${mediaId}@`) ||
				key.startsWith(`${mediaId}:proxy`)
			) {
				this.sinks.delete(key);
				this.initPromises.delete(key);
				this.frameChain.delete(key);
				this.seekGenerations.delete(key);
			}
		}
	}

	clearAll(): void {
		this.sinks.clear();
		this.initPromises.clear();
		this.frameChain.clear();
		this.seekGenerations.clear();
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}

	private getSinkKey({
		mediaId,
		maxSourceSize,
	}: {
		mediaId: string;
		maxSourceSize?: number;
	}): string {
		return maxSourceSize
			? `${mediaId}@${Math.max(2, Math.round(maxSourceSize))}`
			: mediaId;
	}
}

export const videoCache = new VideoCache();
