import { describe, expect, test } from "bun:test";
import {
	resolveMotion,
	getCutPostRoll,
	getMotionIssues,
	fitClipMotion,
	splitClipMotion,
} from ".";
import type { ClipMotion } from "./types";
import type { SceneTracks, VideoElement } from "@/timeline";
import { mediaTime } from "@/wasm";
import { buildScene } from "@/services/renderer/scene-builder";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { AKATZ_VECTORS, brandVectorSvg } from "@/graphics/definitions/akatz";

const ticks = (n: number) => mediaTime({ ticks: n });
const enter: ClipMotion = {
	enter: { kind: "fade", duration: 10, easing: "linear" },
};
const base = {
	transform: { position: { x: 20, y: 30 }, scaleX: 2, scaleY: 3, rotate: 12 },
	opacity: 0.8,
	width: 1920,
	height: 1080,
	duration: 40,
};
function video({
	id,
	start,
	motion,
}: {
	id: string;
	start: number;
	motion?: ClipMotion;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: id,
		startTime: ticks(start),
		duration: ticks(40),
		trimStart: ticks(0),
		trimEnd: ticks(20),
		sourceDuration: ticks(60),
		params: {},
		motion,
	};
}
function tracks(elements: VideoElement[]): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements,
			hidden: false,
			muted: false,
		},
		overlay: [],
		audio: [],
	};
}

describe("shared transition engine", () => {
	test("split-source transitions use distinct stable cursors in preview, proxies, and export", () => {
		const source = tracks([
			video({ id: "a", start: 0 }),
			{
				...video({
					id: "b",
					start: 40,
					motion: { ...enter, fromPrevious: true },
				}),
				mediaId: "a",
				trimStart: ticks(10),
			},
		]);
		for (const isPreview of [true, false]) {
			const file = new File([], "source.mp4");
			const tree = buildScene({
				tracks: source,
				canvasSize: { width: 640, height: 360 },
				duration: 80,
				background: { type: "color", color: "transparent" },
				isPreview,
				mediaAssets: [
					{
						id: "a",
						name: "source",
						type: "video",
						file,
						url: "blob:source",
						proxy: {
							file,
							url: "blob:proxy",
							width: 640,
							height: 360,
							size: 0,
							hardwareEncoded: false,
						},
					},
				],
			});
			const videos = tree.children.filter(
				(node): node is VideoNode => node instanceof VideoNode,
			);
			expect(videos).toHaveLength(2);
			expect(videos.map((node) => node.params.decodeStreamId)).toEqual([
				"clip:a",
				"clip:b",
			]);
			expect(videos.map((node) => node.params.mediaId)).toEqual(
				isPreview ? ["a:proxy", "a:proxy"] : ["a", "a"],
			);
			expect(videos[0].params.postRoll).toBe(10);
		}
	});
	test("fade multiplies opacity without overwriting transform keyframes", () => {
		expect(resolveMotion({ ...base, motion: enter, localTime: 5 })).toEqual({
			transform: base.transform,
			opacity: 0.4,
		});
	});
	test("slide exit moves in the same direction as entrance and seeks deterministically", () => {
		const motion: ClipMotion = {
			enter: { ...enter.enter!, kind: "slide-left" },
			exit: { ...enter.enter!, kind: "slide-left" },
		};
		expect(
			resolveMotion({ ...base, motion, localTime: 35 }).transform.position.x,
		).toBe(20 - 960);
		expect(
			resolveMotion({ ...base, motion, localTime: 5 }).transform.position.x,
		).toBe(20 + 960);
		expect(resolveMotion({ ...base, motion, localTime: 20 }).transform).toEqual(
			base.transform,
		);
	});
	test("cut needs real source handles and accounts for playback rate", () => {
		const incoming = video({
			id: "b",
			start: 40,
			motion: { ...enter, fromPrevious: true },
		});
		expect(
			getCutPostRoll({ previous: video({ id: "a", start: 0 }), incoming }),
		).toBe(10);
		expect(
			getCutPostRoll({
				previous: { ...video({ id: "a", start: 0 }), retime: { rate: 2 } },
				incoming,
			}),
		).toBe(10);
		expect(() =>
			getCutPostRoll({
				previous: { ...video({ id: "a", start: 0 }), retime: { rate: 3 } },
				incoming,
			}),
		).toThrow();
		expect(() =>
			getCutPostRoll({ previous: video({ id: "a", start: 1 }), incoming }),
		).toThrow();
		expect(() =>
			getCutPostRoll({
				previous: { ...video({ id: "a", start: 0 }), hidden: true },
				incoming,
			}),
		).toThrow();
	});
	test("render tree extends only outgoing picture; timeline remains unchanged", () => {
		const source = tracks([
			video({ id: "a", start: 0 }),
			video({ id: "b", start: 40, motion: { ...enter, fromPrevious: true } }),
		]);
		const before = JSON.stringify(source);
		const tree = buildScene({
			tracks: source,
			canvasSize: { width: 1920, height: 1080 },
			duration: 80,
			background: { type: "color", color: "transparent" },
			mediaAssets: ["a", "b"].map((id) => ({
				id,
				name: id,
				type: "video",
				file: new File([], `${id}.mp4`),
				url: `blob:${id}`,
			})),
		});
		const outgoing = tree.children[0];
		expect(outgoing).toBeInstanceOf(VideoNode);
		if (!(outgoing instanceof VideoNode))
			throw new Error("Expected video node");
		expect(outgoing.params.duration).toBe(40);
		expect(outgoing.params.postRoll).toBe(10);
		expect(JSON.stringify(source)).toBe(before);
	});
	test("invalid edits warn in preview and block export", () => {
		const source = tracks([
			video({ id: "a", start: 0 }),
			video({ id: "b", start: 45, motion: { ...enter, fromPrevious: true } }),
		]);
		const options = {
			tracks: source,
			canvasSize: { width: 1920, height: 1080 },
			duration: 85,
			background: { type: "color" as const, color: "transparent" },
			mediaAssets: [],
		};
		expect(getMotionIssues(source)).toHaveLength(1);
		expect(() => buildScene({ ...options, isPreview: true })).not.toThrow();
		expect(() => buildScene({ ...options, isPreview: false })).toThrow(
			"adjacent",
		);
	});
	test("trim fitting and split lifecycle survive JSON save/reload", () => {
		const both = { ...enter, exit: { ...enter.enter!, kind: "pop" as const } };
		const element = video({ id: "a", start: 0, motion: both });
		const updated = applyElementUpdate({
			element,
			patch: { duration: ticks(10) },
			context: { tracks: tracks([element]), trackId: "main" },
		});
		expect(updated.motion?.enter?.duration).toBe(5);
		expect(updated.motion?.exit?.duration).toBe(5);
		expect(JSON.parse(JSON.stringify(updated)).motion).toEqual(updated.motion);
		const [left, right] = splitClipMotion({
			motion: both,
			left: 15,
			right: 25,
		});
		expect(left?.exit).toBeUndefined();
		expect(right?.enter).toBeUndefined();
		expect(right?.fromPrevious).toBe(false);
		expect(fitClipMotion({ motion: undefined, duration: 10 })).toBeUndefined();
	});
	test("each brand asset downloads the same vector paths it renders", () => {
		expect(new Set(AKATZ_VECTORS.map((v) => v.id)).size).toBe(6);
		for (const vector of AKATZ_VECTORS) {
			const svg = brandVectorSvg(vector);
			expect(svg).toContain('viewBox="0 0 512 512"');
			expect(svg).not.toContain("<image");
			for (const part of vector.parts) expect(svg).toContain(part.d);
		}
	});
});
