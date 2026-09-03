"use client";

import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";
import type { AudioSample } from "mediabunny";

const RMS_ANALYSIS_WINDOW_SECONDS = 0.02;
const DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE = 128;

function computePeakBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	const channels = buffer.numberOfChannels;
	const channelData: Float32Array[] = Array.from({ length: channels }, (_, c) =>
		buffer.getChannelData(c),
	);

	return buckets.map(({ bucketStart, bucketEnd }) => {
		let peak = 0;
		for (let c = 0; c < channels; c++) {
			const data = channelData[c];
			for (let j = bucketStart; j < bucketEnd; j++) {
				const abs = Math.abs(data[j] ?? 0);
				if (abs > peak) {
					peak = abs;
				}
			}
		}
		return peak;
	});
}

export interface SampleBucket {
	bucketStart: number;
	bucketEnd: number;
}

export interface SourceWaveformSummary {
	sourceKey: string;
	sampleRate: number;
	totalSamples: number;
	bucketSize: number;
	amplitudes: Float32Array;
}

export interface WaveformAudioBufferChunk {
	sampleRate: number;
	numberOfChannels: number;
	length: number;
	getChannelData: (channel: number) => Float32Array;
}

export function buildWaveformSourceKey({
	kind,
	id,
}: {
	kind: "media" | "library";
	id: string;
}): string {
	return `${kind}:${id}`;
}

export function buildSourceWaveformSummary({
	sourceKey,
	buffer,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	buffer: AudioBuffer;
	bucketSize?: number;
}): SourceWaveformSummary {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const bucketCount = Math.max(1, Math.ceil(buffer.length / safeBucketSize));
	const amplitudes = computePeakBuckets({
		buffer,
		buckets: Array.from({ length: bucketCount }, (_, bucketIndex) => {
			const bucketStart = bucketIndex * safeBucketSize;
			const bucketEnd = Math.min(buffer.length, bucketStart + safeBucketSize);
			return { bucketStart, bucketEnd };
		}),
	});

	return {
		sourceKey,
		sampleRate: buffer.sampleRate,
		totalSamples: buffer.length,
		bucketSize: safeBucketSize,
		amplitudes: Float32Array.from(amplitudes),
	};
}

/**
 * Builds a waveform summary incrementally from decoded audio chunks.
 *
 * Keeping only the current chunk and the downsampled peaks in memory avoids
 * materializing an entire source file and its decoded PCM just to draw a
 * waveform. This is especially important for long video sources.
 */
export async function buildStreamingWaveformSummary({
	sourceKey,
	chunks,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	chunks: AsyncIterable<WaveformAudioBufferChunk>;
	bucketSize?: number;
}): Promise<SourceWaveformSummary> {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const accumulator = new StreamingWaveformAccumulator({
		sourceKey,
		bucketSize: safeBucketSize,
	});

	for await (const chunk of chunks) {
		const channelData = Array.from(
			{ length: chunk.numberOfChannels },
			(_, channel) => chunk.getChannelData(channel),
		);
		accumulator.append({
			sampleRate: chunk.sampleRate,
			frameCount: chunk.length,
			channelData,
		});
	}

	return accumulator.finish();
}

/**
 * Builds the same compact waveform directly from closeable MediaBunny samples.
 * This avoids constructing hundreds of Web Audio `AudioBuffer` objects, which
 * Chrome backs with separate shared-memory file descriptors.
 */
export async function buildStreamingWaveformSummaryFromSamples({
	sourceKey,
	samples,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	samples: AsyncIterable<AudioSample>;
	bucketSize?: number;
}): Promise<SourceWaveformSummary> {
	const accumulator = new StreamingWaveformAccumulator({
		sourceKey,
		bucketSize: Math.max(1, Math.floor(bucketSize)),
	});
	let channelData: Float32Array[] = [];

	for await (const sample of samples) {
		try {
			if (
				channelData.length !== sample.numberOfChannels ||
				channelData[0]?.length !== sample.numberOfFrames
			) {
				channelData = Array.from(
					{ length: sample.numberOfChannels },
					() => new Float32Array(sample.numberOfFrames),
				);
			}
			for (let channel = 0; channel < sample.numberOfChannels; channel++) {
				sample.copyTo(channelData[channel], {
					planeIndex: channel,
					format: "f32-planar",
				});
			}
			accumulator.append({
				sampleRate: sample.sampleRate,
				frameCount: sample.numberOfFrames,
				channelData,
			});
		} finally {
			sample.close();
		}
	}

	return accumulator.finish();
}

class StreamingWaveformAccumulator {
	private readonly amplitudes: number[] = [];
	private readonly sourceKey: string;
	private readonly bucketSize: number;
	private sampleRate = 0;
	private totalSamples = 0;
	private bucketPeak = 0;
	private samplesInBucket = 0;

	constructor({
		sourceKey,
		bucketSize,
	}: {
		sourceKey: string;
		bucketSize: number;
	}) {
		this.sourceKey = sourceKey;
		this.bucketSize = bucketSize;
	}

	append({
		sampleRate,
		frameCount,
		channelData,
	}: {
		sampleRate: number;
		frameCount: number;
		channelData: Float32Array[];
	}): void {
		if (this.sampleRate === 0) {
			this.sampleRate = sampleRate;
		} else if (sampleRate !== this.sampleRate) {
			throw new Error(
				`Waveform chunk sample rate changed from ${this.sampleRate} to ${sampleRate}`,
			);
		}

		for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex++) {
			let samplePeak = 0;
			for (const channel of channelData) {
				samplePeak = Math.max(samplePeak, Math.abs(channel[sampleIndex] ?? 0));
			}

			this.bucketPeak = Math.max(this.bucketPeak, samplePeak);
			this.samplesInBucket += 1;
			this.totalSamples += 1;

			if (this.samplesInBucket === this.bucketSize) {
				this.amplitudes.push(this.bucketPeak);
				this.bucketPeak = 0;
				this.samplesInBucket = 0;
			}
		}
	}

	finish(): SourceWaveformSummary {
		if (this.samplesInBucket > 0) {
			this.amplitudes.push(this.bucketPeak);
			this.bucketPeak = 0;
			this.samplesInBucket = 0;
		}
		return {
			sourceKey: this.sourceKey,
			sampleRate: this.sampleRate,
			totalSamples: this.totalSamples,
			bucketSize: this.bucketSize,
			amplitudes: Float32Array.from(this.amplitudes),
		};
	}
}

export function buildWaveformSampleBuckets({
	clipLeftPx,
	clipRightPx,
	barCount,
	pixelsPerSecond,
	clipDurationSec,
	sourceStartSec,
	retime,
	sampleRate,
	maxSampleExclusive,
	barStepPx,
}: {
	clipLeftPx: number;
	clipRightPx: number;
	barCount: number;
	pixelsPerSecond: number;
	clipDurationSec: number;
	sourceStartSec: number;
	retime?: RetimeConfig;
	sampleRate: number;
	maxSampleExclusive: number;
	barStepPx: number;
}): SampleBucket[] {
	return Array.from({ length: barCount }, (_, index) => {
		const bucketLeftPx = clipLeftPx + index * barStepPx;
		const bucketRightPx = Math.min(clipRightPx, bucketLeftPx + barStepPx);
		const clipStartSec = Math.max(
			0,
			Math.min(clipDurationSec, bucketLeftPx / pixelsPerSecond),
		);
		const clipEndSec = Math.max(
			clipStartSec,
			Math.min(clipDurationSec, bucketRightPx / pixelsPerSecond),
		);
		const sourceBucketStartSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipStartSec,
				retime,
			});
		const sourceBucketEndSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipEndSec,
				retime,
			});

		return {
			bucketStart: Math.max(0, Math.floor(sourceBucketStartSec * sampleRate)),
			bucketEnd: Math.min(
				maxSampleExclusive,
				Math.max(0, Math.ceil(sourceBucketEndSec * sampleRate)),
			),
		};
	});
}

export function sampleSourceWaveformSummary({
	summary,
	buckets,
}: {
	summary: SourceWaveformSummary;
	buckets: SampleBucket[];
}): number[] {
	return buckets.map(({ bucketStart, bucketEnd }) => {
		if (bucketEnd <= bucketStart) {
			return 0;
		}

		const startIndex = Math.max(
			0,
			Math.floor(bucketStart / summary.bucketSize),
		);
		const endIndex = Math.min(
			summary.amplitudes.length,
			Math.max(startIndex + 1, Math.ceil(bucketEnd / summary.bucketSize)),
		);

		let maxAmplitude = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const amplitude = summary.amplitudes[i] ?? 0;
			if (amplitude > maxAmplitude) {
				maxAmplitude = amplitude;
			}
		}

		return maxAmplitude;
	});
}

export function computeRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	const channels = buffer.numberOfChannels;
	const maxWindowLength = Math.max(
		1,
		Math.floor(buffer.sampleRate * RMS_ANALYSIS_WINDOW_SECONDS),
	);

	const channelData: Float32Array[] = new Array(channels);
	for (let c = 0; c < channels; c++) {
		channelData[c] = buffer.getChannelData(c);
	}

	const result = new Array<number>(buckets.length);

	for (let i = 0; i < buckets.length; i++) {
		const { bucketStart, bucketEnd } = buckets[i];
		const bucketLength = bucketEnd - bucketStart;
		if (bucketLength <= 0) {
			result[i] = 0;
			continue;
		}

		const windowLength = Math.max(1, Math.min(bucketLength, maxWindowLength));
		let maxMeanSquare = 0;

		for (let winStart = bucketStart; winStart < bucketEnd; ) {
			const winEnd = Math.min(winStart + windowLength, bucketEnd);
			const n = winEnd - winStart;
			if (n > 0) {
				let sum = 0;
				for (let c = 0; c < channels; c++) {
					const data = channelData[c];
					for (let j = winStart; j < winEnd; j++) {
						const v = data[j];
						sum += v * v;
					}
				}
				const meanSquare = sum / (n * channels);
				if (meanSquare > maxMeanSquare) {
					maxMeanSquare = meanSquare;
				}
			}
			winStart = winEnd;
		}

		result[i] = Math.sqrt(maxMeanSquare);
	}

	return result;
}
