import { expect, test } from "bun:test";
import { getVideoSinkKey } from "./sink-key";

test("same-source clips never share a decoder cursor or canvas pool", () => {
	const a = getVideoSinkKey({
		mediaId: "source",
		maxSourceSize: 720,
		decodeStreamId: "clip:a",
	});
	const b = getVideoSinkKey({
		mediaId: "source",
		maxSourceSize: 720,
		decodeStreamId: "clip:b",
	});
	expect(a).not.toBe(b);
	expect(a).toBe(
		getVideoSinkKey({
			mediaId: "source",
			maxSourceSize: 720,
			decodeStreamId: "clip:a",
		}),
	);
	expect(a.startsWith("source@")).toBe(true);
	expect(b.startsWith("source@")).toBe(true);
});

test("resolution, proxy, and background cursors stay separate", () => {
	const base = {
		mediaId: "source",
		maxSourceSize: 720,
		decodeStreamId: "clip:a",
	};
	expect(
		new Set([
			getVideoSinkKey(base),
			getVideoSinkKey({ ...base, maxSourceSize: 1080 }),
			getVideoSinkKey({ ...base, mediaId: "source:proxy" }),
			getVideoSinkKey({ ...base, decodeStreamId: "background:a" }),
		]).size,
	).toBe(4);
	expect(
		getVideoSinkKey({ ...base, mediaId: "source:proxy" }).startsWith(
			"source:proxy",
		),
	).toBe(true);
});

test("legacy requests retain their keys and native-size clip keys remain clearable", () => {
	expect(getVideoSinkKey({ mediaId: "source" })).toBe("source");
	expect(getVideoSinkKey({ mediaId: "source", maxSourceSize: 720.2 })).toBe(
		"source@720",
	);
	expect(
		getVideoSinkKey({ mediaId: "source", decodeStreamId: "clip:a" }).startsWith(
			"source@",
		),
	).toBe(true);
});
