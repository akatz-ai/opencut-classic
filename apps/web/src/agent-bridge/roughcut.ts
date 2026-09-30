import { planRoughCut } from "opencut-wasm";
import type { EditorCore } from "@/core";
import { effectsRegistry } from "@/effects/registry";
import { graphicsRegistry } from "@/graphics/registry";
import { getBuiltInElementParams } from "@/params/registry";
import { getMotionIssues } from "@/motion";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { SceneTracks } from "@/timeline";
import type { AgentProjectSnapshot } from "./types";

export function roughCutDefinitions() {
	return Object.fromEntries([
		...(["video", "audio", "image", "text", "graphic"] as const).map((type) => [
			type,
			getBuiltInElementParams({
				type,
			}),
		]),
		...graphicsRegistry
			.getAll()
			.map((d) => [
				`graphic:${d.id}`,
				[...getBuiltInElementParams({ type: "graphic" }), ...d.params],
			]),
		...effectsRegistry.getAll().map((d) => [`effect:${d.type}`, d.params]),
	]);
}

export function roughCutCatalog(definition?: unknown) {
	const definitions = roughCutDefinitions();
	if (typeof definition === "string") {
		if (!(definition in definitions)) throw new Error("Unknown definition");
		return { definition, params: definitions[definition] };
	}
	return {
		operations: {
			addTrack: "{op, id, kind: video|audio|text|graphic, name}",
			insert:
				"{op, id, trackId, kind: video|audio|image|text|graphic, startSeconds, durationSeconds, sourceInSeconds?:0, mediaId?:required for media, definitionId?:required for graphic, params?:{}}",
			setParams:
				"{op, id:clipId, params:{key:value}}; merges static parameters; animated clips rejected",
			move: "{op, id:clipId, trackId, startSeconds}; no ripple",
			remove: "{op, id:clipId}; leaves a gap",
			setEffect:
				"{op, id:clipId, effectId, effectType, params?:{}, enabled?:true}; replaces matching effectId, otherwise appends; omitted parameters use defaults",
			setMotion:
				"{op, id:clipId, edge:enter|exit|cut, kind:fade|slide-left|slide-right|slide-up|slide-down|pop|null, durationSeconds, easing?:smooth}; null removes; cut needs adjacent clips and outgoing source handle",
		},
		definitions: Object.keys(definitions),
		limits: {
			operations: 100,
			timeUnit: "seconds (rounded to project frames)",
			sameTrackOverlap: false,
		},
		units: {
			positions: "canvas pixels, relative to center",
			fontSize: "OpenCut units: rendered pixels = fontSize * canvasHeight / 90",
			opacity: "0-1",
			volume: "decibels",
		},
	};
}

/** Rust plans data; this adapter retains browser-owned audio buffers and commits one undo step. */
export function applyRoughCut({
	editor,
	snapshot,
	payload,
	assertCurrent,
}: {
	editor: EditorCore;
	snapshot: AgentProjectSnapshot;
	payload: Record<string, unknown>;
	assertCurrent: () => void;
}): Record<string, unknown> {
	const before = editor.scenes.getActiveScene().tracks;
	// The pure Rust boundary validates the operation schema and returns a complete timeline.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const planned = planRoughCut({
		tracks: snapshot.activeScene.tracks,
		media: snapshot.media,
		fps: snapshot.project.fps,
		definitions: roughCutDefinitions(),
		operations: payload.operations,
	}) as { tracks: SceneTracks; changedIds: string[] };
	const issues = getMotionIssues(planned.tracks);
	if (issues.length) throw new Error(issues.join("; "));
	for (const track of planned.tracks.audio) {
		for (const element of track.elements) {
			const original = before.audio
				.flatMap((t) => t.elements)
				.find((e) => e.id === element.id);
			if (original?.buffer) element.buffer = original.buffer;
		}
	}
	assertCurrent();
	const tracks = [
		planned.tracks.main,
		...planned.tracks.overlay,
		...planned.tracks.audio,
	];
	const summary = {
		dryRun: payload.dryRun === true,
		changedIds: planned.changedIds,
		tracks: tracks.map((t) => ({
			id: t.id,
			name: t.name,
			type: t.type,
			clipCount: t.elements.length,
		})),
		durationSeconds: Math.max(
			0,
			...tracks.flatMap((t) =>
				t.elements.map((e) => (e.startTime + e.duration) / 120000),
			),
		),
	};
	if (payload.dryRun !== undefined && typeof payload.dryRun !== "boolean")
		throw new Error("dryRun must be boolean");
	if (!summary.dryRun) {
		const ripple = editor.command.isRippleEnabled;
		try {
			editor.command.isRippleEnabled = false;
			editor.command.execute({
				command: new TracksSnapshotCommand({ before, after: planned.tracks }),
			});
		} finally {
			editor.command.isRippleEnabled = ripple;
		}
	}
	return summary;
}
