import { describe, expect, test } from "bun:test";
import { shouldGeneratePreviewProxy } from "@/media/proxy-policy";
import type { MediaAsset } from "@/media/types";

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "video",
		name: "video.mp4",
		type: "video",
		file: new File([], "video.mp4"),
		width: 1280,
		height: 720,
		fps: 30,
		...overrides,
	};
}

describe("shouldGeneratePreviewProxy", () => {
	test("proxies 4K and high-frame-rate media", () => {
		expect(
			shouldGeneratePreviewProxy({
				asset: video({ width: 3840, height: 2160 }),
			}),
		).toBeTrue();
		expect(
			shouldGeneratePreviewProxy({ asset: video({ fps: 60 }) }),
		).toBeTrue();
	});

	test("proxies unsupported codecs even at small resolutions", () => {
		expect(
			shouldGeneratePreviewProxy({ asset: video({ canDecode: false }) }),
		).toBeTrue();
	});

	test("keeps already-light or already-proxied media", () => {
		expect(shouldGeneratePreviewProxy({ asset: video() })).toBeFalse();
		expect(
			shouldGeneratePreviewProxy({
				asset: video({
					proxy: {
						file: new File([], "proxy.mp4"),
						url: "blob:proxy",
						width: 1280,
						height: 720,
						size: 0,
						hardwareEncoded: false,
					},
				}),
			}),
		).toBeFalse();
	});
});
