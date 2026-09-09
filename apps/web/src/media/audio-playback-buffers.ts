import type { WrappedAudioBuffer } from "mediabunny";

export interface PlaybackAudioBuffer extends WrappedAudioBuffer {
	/** Neighbor samples for Web Audio's resampler; not part of the audible span. */
	offsetSeconds: number;
	/** Buffer-clock seconds per original source second (PCM itself is unchanged). */
	sampleRateRatio: number;
}

// AudioBufferSourceNode resamples each source independently. Starting/stopping
// at AAC packet edges otherwise substitutes silence for the filter's neighbors,
// causing clicks (notably 32 kHz sources on a 48 kHz output). Keep the neighboring
// PCM in the buffer and schedule only the original span with start/stop.
// This is a Web Audio adapter, not a change to stored media or export audio.
// Store PCM on the output buffer clock and carry the source/output rate ratio
// in playbackRate. This also preserves fractional source offsets consistently
// (implicit 44.1 -> 48 kHz conversion at playbackRate=1 can round those offsets).
// No PCM resampling happens here; Web Audio still performs the interpolation.
const RESAMPLER_CONTEXT_SAMPLES = 512;

/** Schedule on output sample boundaries without playing the padding or doubling
 * a sample at adjacent packet edges (duration-based stops can round differently).
 */
export function schedulePlaybackAudioBuffer({
	context,
	node,
	startTime,
	duration,
	offsetSeconds,
	rate,
}: {
	context: Pick<BaseAudioContext, "currentTime" | "sampleRate">;
	node: Pick<AudioBufferSourceNode, "start" | "stop">;
	startTime: number;
	duration: number;
	offsetSeconds: number;
	rate: number;
}): boolean {
	// Ignore sub-sample floating-point noise at mathematically identical edges.
	const onOutputSample = (time: number) =>
		Math.ceil(time * context.sampleRate - 1e-7) / context.sampleRate;
	const start = onOutputSample(Math.max(startTime, context.currentTime));
	const end = onOutputSample(startTime + duration / rate);
	if (start >= end) return false;
	// Preserve the source phase when rounding or catching up to a late packet.
	node.start(start, Math.max(0, offsetSeconds + (start - startTime) * rate));
	node.stop(end);
	return true;
}

// eslint-disable-next-line opencut/prefer-object-params -- Pairwise buffer adjacency predicate.
function areAdjacent(a: WrappedAudioBuffer, b: WrappedAudioBuffer): boolean {
	return (
		a.buffer.sampleRate === b.buffer.sampleRate &&
		a.buffer.numberOfChannels === b.buffer.numberOfChannels &&
		Math.abs(a.timestamp + a.buffer.duration - b.timestamp) <
			0.5 / a.buffer.sampleRate
	);
}

/** One-chunk lookahead; memory stays bounded regardless of the media length. */
export async function* playbackAudioBuffers({
	chunks,
	context,
}: {
	chunks: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
	context: Pick<BaseAudioContext, "createBuffer" | "sampleRate">;
}): AsyncGenerator<PlaybackAudioBuffer, void, unknown> {
	let previous: WrappedAudioBuffer | undefined;
	try {
		let current = await chunks.next();
		while (!current.done) {
			const next = await chunks.next();
			const original = current.value;
			const left =
				previous && areAdjacent(previous, original)
					? Math.min(RESAMPLER_CONTEXT_SAMPLES, previous.buffer.length)
					: 0;
			const right =
				!next.done && areAdjacent(original, next.value)
					? Math.min(RESAMPLER_CONTEXT_SAMPLES, next.value.buffer.length)
					: 0;
			let buffer = original.buffer;
			if (left || right || original.buffer.sampleRate !== context.sampleRate) {
				buffer = context.createBuffer(
					original.buffer.numberOfChannels,
					left + original.buffer.length + right,
					context.sampleRate,
				);
				for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
					if (left && previous) {
						buffer.copyToChannel(
							previous.buffer.getChannelData(channel).subarray(-left),
							channel,
						);
					}
					buffer.copyToChannel(
						original.buffer.getChannelData(channel),
						channel,
						left,
					);
					if (right && !next.done) {
						buffer.copyToChannel(
							next.value.buffer.getChannelData(channel).subarray(0, right),
							channel,
							left + original.buffer.length,
						);
					}
				}
			}
			yield {
				buffer,
				timestamp: original.timestamp,
				duration: original.buffer.duration,
				offsetSeconds: left / buffer.sampleRate,
				sampleRateRatio: original.buffer.sampleRate / buffer.sampleRate,
			};
			previous = original;
			current = next;
		}
	} finally {
		await chunks.return();
	}
}
