// Preserve the browser's animated volume mix as PCM for native AAC.
// Chunking avoids allocating another complete interleaved timeline buffer.
export function timelineMixToWav(
	buffer: Pick<
		AudioBuffer,
		"numberOfChannels" | "sampleRate" | "length" | "getChannelData"
	>,
): File {
	const channels = buffer.numberOfChannels;
	const dataSize = buffer.length * channels * 2;
	if (dataSize > 0xffffffff - 36) {
		throw new Error("Animated audio mix exceeds the WAV size limit");
	}
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	for (const [offset, value] of [
		[0, "RIFF"],
		[8, "WAVE"],
		[12, "fmt "],
		[36, "data"],
	] as const) {
		for (let i = 0; i < value.length; i++)
			view.setUint8(offset + i, value.charCodeAt(i));
	}
	view.setUint32(4, 36 + dataSize, true);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, buffer.sampleRate, true);
	view.setUint32(28, buffer.sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	view.setUint32(40, dataSize, true);
	const parts: ArrayBuffer[] = [header];
	const samples = Array.from({ length: channels }, (_, channel) =>
		buffer.getChannelData(channel),
	);
	for (let start = 0; start < buffer.length; start += 16_384) {
		const length = Math.min(16_384, buffer.length - start);
		const chunk = new ArrayBuffer(length * channels * 2);
		const pcm = new DataView(chunk);
		for (let i = 0; i < length; i++) {
			for (let channel = 0; channel < channels; channel++) {
				const sample = Math.max(-1, Math.min(1, samples[channel][start + i]));
				pcm.setInt16(
					(i * channels + channel) * 2,
					Math.round(sample * (sample < 0 ? 32768 : 32767)),
					true,
				);
			}
		}
		parts.push(chunk);
	}
	return new File(parts, "timeline-mix.wav", { type: "audio/wav" });
}
