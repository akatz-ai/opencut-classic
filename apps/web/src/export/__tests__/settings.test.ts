import { describe, expect, test } from "bun:test";
import {
	estimateExportSizeBytes,
	estimateExportSizeRangeBytes,
	formatExportDuration,
	formatExportSize,
	getExportVideoBitrate,
	resolveExportDimensions,
} from "../settings";

describe("export settings", () => {
	test("preserves project aspect ratio for landscape and portrait presets", () => {
		expect(
			resolveExportDimensions({
				projectWidth: 2560,
				projectHeight: 1440,
				preset: "1080p",
			}),
		).toEqual({ width: 1920, height: 1080 });
		expect(
			resolveExportDimensions({
				projectWidth: 1080,
				projectHeight: 1920,
				preset: "720p",
			}),
		).toEqual({ width: 720, height: 1280 });
	});

	test("increases bitrate with quality, resolution, and frame rate", () => {
		const base = getExportVideoBitrate({
			width: 1920,
			height: 1080,
			fps: 30,
			quality: 50,
			format: "mp4",
		});
		expect(
			getExportVideoBitrate({
				width: 1920,
				height: 1080,
				fps: 30,
				quality: 80,
				format: "mp4",
			}),
		).toBeGreaterThan(base);
		expect(
			getExportVideoBitrate({
				width: 2560,
				height: 1440,
				fps: 60,
				quality: 50,
				format: "mp4",
			}),
		).toBeGreaterThan(base);
	});

	test("estimates container size and formats time and bytes", () => {
		const bytes = estimateExportSizeBytes({
			durationSeconds: 600,
			videoBitrate: 10_000_000,
			includeAudio: true,
		});
		expect(bytes).toBe(779_688_000);
		expect(formatExportSize(bytes)).toBe("744 MiB");
		expect(formatExportDuration(3_723_000)).toBe("1:02:03");
		expect(
			estimateExportSizeRangeBytes({
				durationSeconds: 600,
				videoBitrate: 10_000_000,
				includeAudio: true,
				bitrateMode: "variable",
			}),
		).toEqual({ minimum: 350_859_600, maximum: 779_688_000 });
	});
});
