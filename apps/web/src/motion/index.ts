import {
	evaluateMotion,
	validateMotionCut,
	fitMotion,
	splitMotion,
} from "opencut-wasm";
import type { Transform } from "@/rendering";
import type { SceneTracks, TimelineElement } from "@/timeline";
import type { ClipMotion } from "./types";
export type { ClipMotion, ClipTransition, TransitionKind } from "./types";

/** Rust owns timing/easing. This adapter maps its normalized motion to canvas pixels. */
export function resolveMotion({
	motion,
	localTime,
	duration,
	transform,
	opacity,
	width,
	height,
}: {
	motion?: ClipMotion;
	localTime: number;
	duration: number;
	transform: Transform;
	opacity: number;
	width: number;
	height: number;
}) {
	if (!motion) return { transform, opacity };
	const delta = evaluateMotion(motion, localTime, duration);
	return {
		transform: {
			...transform,
			position: {
				x: transform.position.x + delta.x * width,
				y: transform.position.y + delta.y * height,
			},
			scaleX: transform.scaleX * delta.scale,
			scaleY: transform.scaleY * delta.scale,
		},
		opacity: opacity * delta.opacity,
	};
}

export function validateClipMotion({
	motion,
	duration,
}: {
	motion: ClipMotion;
	duration: number;
}) {
	evaluateMotion(motion, 0, duration);
}

export function fitClipMotion({
	motion,
	duration,
}: {
	motion: ClipMotion | undefined;
	duration: number;
}): ClipMotion | undefined {
	return motion ? fitMotion(motion, duration) : undefined;
}

export function splitClipMotion({
	motion,
	left,
	right,
}: {
	motion: ClipMotion | undefined;
	left: number;
	right: number;
}): [ClipMotion | undefined, ClipMotion | undefined] {
	return motion ? splitMotion(motion, left, right) : [undefined, undefined];
}

/** Rendering adapter: an outgoing source handle remains visible beneath the incoming picture. */
export function getCutPostRoll({
	previous,
	incoming,
}: {
	previous: TimelineElement | undefined;
	incoming: TimelineElement;
}): number {
	if (!incoming.motion?.fromPrevious || !incoming.motion.enter) return 0;
	if (
		!previous ||
		(previous.type !== "video" && previous.type !== "image") ||
		(incoming.type !== "video" && incoming.type !== "image")
	) {
		throw new Error(
			"Select an incoming video or image with a previous clip on the same track",
		);
	}
	if (previous.hidden || previous.motion?.exit)
		throw new Error(
			"The previous clip must be visible and have no exit transition",
		);
	const duration = incoming.motion.enter.duration;
	const handle =
		previous.type === "video"
			? previous.trimEnd / (previous.retime?.rate ?? 1)
			: duration;
	validateMotionCut(
		previous.startTime + previous.duration,
		incoming.startTime,
		handle,
		duration,
	);
	return duration;
}

export function getMotionIssues(tracks?: SceneTracks): string[] {
	if (!tracks) return [];
	const issues: string[] = [];
	for (const track of [tracks.main, ...tracks.overlay]) {
		if (track.hidden) continue;
		const elements = [...track.elements]
			.filter((e) => !("hidden" in e && e.hidden))
			.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
		for (const [index, element] of elements.entries()) {
			try {
				if (element.motion)
					validateClipMotion({
						motion: element.motion,
						duration: element.duration,
					});
				getCutPostRoll({ previous: elements[index - 1], incoming: element });
			} catch (error) {
				issues.push(
					`${element.name}: ${String(error instanceof Error ? error.message : error)}`,
				);
			}
		}
	}
	return issues;
}
