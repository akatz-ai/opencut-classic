import { describe, expect, test } from "bun:test";
import {
	estimateExportSizeBytes,
	estimateExportSizeRangeBytes,
	formatExportDuration,
	formatExportSize,
	getExportVideoBitrate,
	resolveExportDimensions,
	fitExportFrame,
	EXPORT_RESOLUTION_LABELS,
} from "../settings";

describe("export settings", () => {
	test("Instagram labels map to exact portrait and landscape sizes through WASM", () => {
		for (const [preset, short, long] of [
			["insta_hd", 1080, 1920],
			["insta_2k", 1440, 2560],
			["insta_4k", 2160, 3840],
		] as const) {
			expect(EXPORT_RESOLUTION_LABELS[preset]).toStartWith("Insta ");
			expect(
				resolveExportDimensions({
					projectWidth: 1080,
					projectHeight: 1920,
					preset,
				}),
			).toEqual({ width: short, height: long });
			expect(
				resolveExportDimensions({
					projectWidth: 2688,
					projectHeight: 1536,
					preset,
				}),
			).toEqual({ width: long, height: short });
		}
	});

	test("fits the live 7:4 project into 4K without changing the composition", () => {
		expect(
			fitExportFrame({
				width: 2688,
				height: 1536,
				outputWidth: 3840,
				outputHeight: 2160,
			}),
		).toEqual({ width: 3780, height: 2160, x: 30, y: 0 });
	});

	test("100% quality selects the maximum bitrate without reducing 4K dimensions", () => {
		const dimensions = resolveExportDimensions({
			projectWidth: 1080,
			projectHeight: 1920,
			preset: "insta_4k",
		});
		const input = { ...dimensions, fps: 30, format: "mp4" as const };
		expect(getExportVideoBitrate({ ...input, quality: 100 })).toBe(29_900_000);
		expect(getExportVideoBitrate({ ...input, quality: 100 })).toBeGreaterThan(
			getExportVideoBitrate({ ...input, quality: 60 }),
		);
		expect(getExportVideoBitrate({ ...input, quality: 200 })).toBe(
			getExportVideoBitrate({ ...input, quality: 100 }),
		);
		expect(dimensions).toEqual({ width: 2160, height: 3840 });
	});

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
