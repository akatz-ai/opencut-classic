import { describe, expect, test } from "bun:test";
import { getPreviewRenderSize } from "@/preview/adaptive-resolution";

describe("getPreviewRenderSize", () => {
	test("uses a quarter-size surface for a fitted 4K preview", () => {
		expect(
			getPreviewRenderSize({
				canvasSize: { width: 3840, height: 2160 },
				viewportSize: { width: 800, height: 450 },
				devicePixelRatio: 1,
				mode: "auto",
			}),
		).toEqual({ width: 960, height: 540 });
	});

	test("accounts for high-density displays without exceeding the project", () => {
		expect(
			getPreviewRenderSize({
				canvasSize: { width: 1920, height: 1080 },
				viewportSize: { width: 800, height: 450 },
				devicePixelRatio: 2,
				mode: "auto",
			}),
		).toEqual({ width: 1920, height: 1080 });
	});

	test("honors explicit quality modes and keeps encoder-safe even sizes", () => {
		expect(
			getPreviewRenderSize({
				canvasSize: { width: 1919, height: 1079 },
				viewportSize: { width: 800, height: 450 },
				mode: "half",
			}),
		).toEqual({ width: 960, height: 540 });
		expect(
			getPreviewRenderSize({
				canvasSize: { width: 1919, height: 1079 },
				viewportSize: { width: 800, height: 450 },
				mode: "quarter",
			}),
		).toEqual({ width: 480, height: 270 });
	});
});
