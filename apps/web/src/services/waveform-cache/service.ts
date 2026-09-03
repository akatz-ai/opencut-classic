"use client";

import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import { createAudioContext } from "@/media/audio";
import {
	buildSourceWaveformSummary,
	buildStreamingWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";

async function* mapAsync<TInput, TOutput>({
	source,
	transform,
}: {
	source: AsyncIterable<TInput>;
	transform: (value: TInput) => TOutput;
}): AsyncGenerator<TOutput, void, unknown> {
	for await (const value of source) {
		yield transform(value);
	}
}

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		}).catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		if (sourceFile) {
			return this.buildSummaryFromFile({ sourceKey, file: sourceFile });
		}

		if (!audioUrl) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const response = await fetch(audioUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch waveform source: ${response.status}`);
		}
		const arrayBuffer = await response.arrayBuffer();

		const audioContext = createAudioContext();
		try {
			const buffer = await audioContext.decodeAudioData(arrayBuffer);
			return buildSourceWaveformSummary({ sourceKey, buffer });
		} finally {
			void audioContext.close();
		}
	}

	private async buildSummaryFromFile({
		sourceKey,
		file,
	}: {
		sourceKey: string;
		file: File;
	}): Promise<SourceWaveformSummary> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				return {
					sourceKey,
					sampleRate: 0,
					totalSamples: 0,
					bucketSize: 1,
					amplitudes: new Float32Array(0),
				};
			}

			const sink = new AudioBufferSink(audioTrack);
			return await buildStreamingWaveformSummary({
				sourceKey,
				chunks: mapAsync({
					source: sink.buffers(0),
					transform: ({ buffer }) => buffer,
				}),
			});
		} finally {
			input.dispose();
		}
	}
}

export const waveformCache = new WaveformCache();
