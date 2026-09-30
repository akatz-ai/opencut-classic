import type { ExportFormat } from "@/export";

export const EXPORT_AUDIO_BITRATE = 192_000;

export async function requireExportAudioCodec({
	format,
	sampleRate,
	numberOfChannels,
	encoder = globalThis.AudioEncoder,
}: {
	format: ExportFormat;
	sampleRate: number;
	numberOfChannels: number;
	encoder?: Pick<typeof AudioEncoder, "isConfigSupported">;
}): Promise<"aac" | "opus"> {
	if (format === "webm") return "opus";
	const config = {
		codec: "mp4a.40.2",
		sampleRate,
		numberOfChannels,
		bitrate: EXPORT_AUDIO_BITRATE,
	};
	if (!encoder || !(await encoder.isConfigSupported(config)).supported) {
		throw new Error(
			"MP4 export requires AAC audio. Browser AAC encoding is unavailable; the local media engine must be available to encode AAC. Export stopped without substituting another codec.",
		);
	}
	return "aac";
}
