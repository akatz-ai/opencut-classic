import type { ExportBitrateMode, ExportFormat, ExportQuality } from "./index";

export const EXPORT_RESOLUTION_PRESETS = [
	"project",
	"2160p",
	"1440p",
	"1080p",
	"720p",
] as const;

export type ExportResolutionPreset = (typeof EXPORT_RESOLUTION_PRESETS)[number];

export const DEFAULT_EXPORT_QUALITY_SLIDER = 60;
export const MIN_EXPORT_QUALITY_SLIDER = 1;
export const MAX_EXPORT_QUALITY_SLIDER = 100;

const LONG_EDGE_BY_PRESET: Record<
	Exclude<ExportResolutionPreset, "project">,
	number
> = {
	"2160p": 3840,
	"1440p": 2560,
	"1080p": 1920,
	"720p": 1280,
};

const QUALITY_SLIDER_BY_LEGACY_PRESET: Record<ExportQuality, number> = {
	low: 25,
	medium: 45,
	high: DEFAULT_EXPORT_QUALITY_SLIDER,
	very_high: 82,
};

export function getQualitySliderForPreset(quality: ExportQuality): number {
	return QUALITY_SLIDER_BY_LEGACY_PRESET[quality];
}

export function resolveExportDimensions({
	projectWidth,
	projectHeight,
	preset,
}: {
	projectWidth: number;
	projectHeight: number;
	preset: ExportResolutionPreset;
}): { width: number; height: number } {
	if (projectWidth <= 0 || projectHeight <= 0) {
		throw new Error("Project dimensions must be positive");
	}
	if (preset === "project") {
		return {
			width: even({ value: projectWidth }),
			height: even({ value: projectHeight }),
		};
	}
	const longEdge = LONG_EDGE_BY_PRESET[preset];
	if (projectWidth >= projectHeight) {
		return {
			width: longEdge,
			height: even({ value: (longEdge * projectHeight) / projectWidth }),
		};
	}
	return {
		width: even({ value: (longEdge * projectWidth) / projectHeight }),
		height: longEdge,
	};
}

export function getExportVideoBitrate({
	width,
	height,
	fps,
	quality,
	format,
}: {
	width: number;
	height: number;
	fps: number;
	quality: number;
	format: ExportFormat;
}): number {
	const normalizedQuality = clamp({
		value: quality,
		minimum: MIN_EXPORT_QUALITY_SLIDER,
		maximum: MAX_EXPORT_QUALITY_SLIDER,
	});
	const h264BitsPerPixel =
		0.012 * 10 ** ((normalizedQuality / MAX_EXPORT_QUALITY_SLIDER) * 1);
	const codecFactor = format === "webm" ? 0.65 : 1;
	const bitrate = width * height * fps * h264BitsPerPixel * codecFactor;
	return (
		Math.round(
			clamp({ value: bitrate, minimum: 1_000_000, maximum: 80_000_000 }) /
				100_000,
		) * 100_000
	);
}

export function estimateExportSizeBytes({
	durationSeconds,
	videoBitrate,
	includeAudio,
}: {
	durationSeconds: number;
	videoBitrate: number;
	includeAudio: boolean;
}): number {
	const audioBitrate = includeAudio ? 192_000 : 0;
	return Math.ceil(
		(durationSeconds * (videoBitrate + audioBitrate) * 1.02) / 8,
	);
}

export function estimateExportSizeRangeBytes({
	durationSeconds,
	videoBitrate,
	includeAudio,
	bitrateMode,
}: {
	durationSeconds: number;
	videoBitrate: number;
	includeAudio: boolean;
	bitrateMode: ExportBitrateMode;
}): { minimum: number; maximum: number } {
	const target = estimateExportSizeBytes({
		durationSeconds,
		videoBitrate,
		includeAudio,
	});
	if (bitrateMode === "constant") {
		return {
			minimum: Math.floor(target * 0.95),
			maximum: Math.ceil(target * 1.05),
		};
	}
	return { minimum: Math.floor(target * 0.45), maximum: target };
}

export function formatExportSize(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
	return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function formatExportDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function even({ value }: { value: number }): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

function clamp({
	value,
	minimum,
	maximum,
}: {
	value: number;
	minimum: number;
	maximum: number;
}): number {
	return Math.min(maximum, Math.max(minimum, value));
}
