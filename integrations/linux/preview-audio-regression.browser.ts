import {
	playbackAudioBuffers,
	schedulePlaybackAudioBuffer,
} from "../../apps/web/src/media/audio-playback-buffers";

async function compare(sourceRate: number, rate: number, seek: number) {
	const frames = sourceRate * 2;
	const original = new AudioBuffer({
		length: frames,
		numberOfChannels: 1,
		sampleRate: sourceRate,
	});
	const samples = original.getChannelData(0);
	for (let i = 0; i < frames; i++) {
		samples[i] =
			0.4 * Math.sin((2 * Math.PI * 440 * i) / sourceRate) +
			0.25 * Math.sin((2 * Math.PI * 1234 * i) / sourceRate);
	}
	const length = Math.ceil(((2 - seek) * 48_000) / rate);
	async function render(padded: boolean) {
		const context = new OfflineAudioContext(1, length, 48_000);
		if (padded) {
			async function* chunks() {
				for (
					let offset = Math.floor((seek * sourceRate) / 1024) * 1024;
					offset < frames;
					offset += 1024
				) {
					const buffer = context.createBuffer(
						1,
						Math.min(1024, frames - offset),
						sourceRate,
					);
					buffer.copyToChannel(
						samples.subarray(offset, offset + buffer.length),
						0,
					);
					yield {
						buffer,
						timestamp: offset / sourceRate,
						duration: buffer.duration,
					};
				}
			}
			for await (const packet of playbackAudioBuffers({
				chunks: chunks(),
				context,
			})) {
				const node = context.createBufferSource();
				node.buffer = packet.buffer;
				node.playbackRate.value = rate * packet.sampleRateRatio;
				node.connect(context.destination);
				schedulePlaybackAudioBuffer({
					context,
					node,
					rate: rate * packet.sampleRateRatio,
					startTime: (packet.timestamp - seek) / rate,
					duration: packet.duration * packet.sampleRateRatio,
					offsetSeconds: packet.offsetSeconds,
				});
			}
		} else {
			const node = context.createBufferSource();
			node.buffer = original;
			node.playbackRate.value = rate;
			node.connect(context.destination);
			node.start(0, seek);
		}
		return (await context.startRendering()).getChannelData(0);
	}
	const actual = await render(true),
		reference = await render(false);
	let peakDifference = 0,
		squared = 0;
	// The initial seek and the end of a finite source can have filter-edge transients;
	// compare the interior, which includes every subsequent packet boundary.
	for (let i = 512; i < length - 512; i++) {
		const delta = actual[i] - reference[i];
		peakDifference = Math.max(peakDifference, Math.abs(delta));
		squared += delta * delta;
	}
	return {
		sourceRate,
		rate,
		seek,
		peakDifference,
		rmsDifference: Math.sqrt(squared / (length - 1024)),
	};
}

void (async () => {
	try {
		const results = [];
		for (const sourceRate of [32_000, 44_100, 48_000]) {
			for (const rate of [0.5, 1, 1.5, 2, 5]) {
				// Sample-aligned but not AAC-packet-aligned, avoiding the native
				// single-source offset rounding quirk in the reference itself.
				// Fractional output scheduling is covered by the unit tests.
				for (const seek of [0, 0.04])
					results.push(await compare(sourceRate, rate, seek));
			}
		}
		await fetch("/result", {
			method: "POST",
			body: JSON.stringify({ results }),
		});
	} catch (error) {
		await fetch("/result", {
			method: "POST",
			body: JSON.stringify({ error: String(error) }),
		});
	}
})();
