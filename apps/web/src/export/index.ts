import type { FrameRate } from "opencut-wasm";
import type { StreamTargetChunk } from "mediabunny";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
}

export interface ExportDestination {
	writable: WritableStream<StreamTargetChunk>;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	savedToFile?: boolean;
	error?: string;
	cancelled?: boolean;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

type SaveFilePickerWindow = Window & {
	showSaveFilePicker?: (options: {
		suggestedName?: string;
		types?: Array<{
			description?: string;
			accept: Record<string, string[]>;
		}>;
	}) => Promise<FileSystemFileHandle>;
};

export type ExportDestinationSelection =
	| { status: "selected"; destination: ExportDestination }
	| { status: "cancelled" }
	| { status: "unavailable" };

export async function selectExportDestination({
	filename,
	mimeType,
	extension,
}: {
	filename: string;
	mimeType: string;
	extension: string;
}): Promise<ExportDestinationSelection> {
	const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
	if (!picker) {
		return { status: "unavailable" };
	}

	try {
		const handle = await picker.call(window, {
			suggestedName: filename,
			types: [
				{
					description: `${extension.slice(1).toUpperCase()} video`,
					accept: { [mimeType]: [extension] },
				},
			],
		});
		const writable = await handle.createWritable();
		return {
			status: "selected",
			destination: {
				writable: writable as WritableStream<StreamTargetChunk>,
			},
		};
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			return { status: "cancelled" };
		}
		throw error;
	}
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
