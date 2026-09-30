import type { AgentProjectSnapshot } from "./types";

export function presentAgentState({
	state,
	query = new URLSearchParams(),
}: {
	state: AgentProjectSnapshot;
	query?: URLSearchParams;
}) {
	const tracks = [
		state.activeScene.tracks.main,
		...state.activeScene.tracks.overlay,
		...state.activeScene.tracks.audio,
	];
	const summary = {
		sessionId: state.sessionId,
		revision: state.revision,
		receivedAt: state.receivedAt,
		agentPaused: state.agentPaused,
		project: state.project,
		activeScene: { id: state.activeScene.id, name: state.activeScene.name },
		playheadSeconds: state.playheadSeconds,
		selectedElements: state.selectedElements ?? [],
		mediaCount: state.media.length,
		tracks: tracks.map((t) => ({
			id: t.id,
			name: t.name,
			type: t.type,
			clipCount: t.elements.length,
		})),
	};
	const detail = query.get("detail") ?? "overview";
	if (detail === "overview") return summary;
	if (detail === "full") return state;
	const offset = Number(query.get("offset") ?? 0);
	const limit = Number(query.get("limit") ?? 30);
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		throw new Error("offset must be nonnegative; limit must be 1-100");
	if (detail === "media")
		return {
			...summary,
			total: state.media.length,
			offset,
			items: state.media.slice(offset, offset + limit),
		};
	const all = tracks.flatMap((t) =>
		t.elements.map((e) => ({ trackId: t.id, element: e })),
	);
	if (detail === "clip") {
		const clip = all.find((c) => c.element.id === query.get("clipId"));
		if (!clip) throw new Error("Clip not found; provide clipId");
		return { sessionId: state.sessionId, revision: state.revision, ...clip };
	}
	if (detail !== "timeline")
		throw new Error("detail must be overview, media, timeline, clip, or full");
	const start = Number(query.get("start") ?? 0);
	const end = Number(query.get("end") ?? 86400);
	if (
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start < 0 ||
		end <= start
	)
		throw new Error("Invalid timeline window");
	const selected = all
		.filter(
			({ element: e }) =>
				e.startTime / 120000 < end &&
				(e.startTime + e.duration) / 120000 > start,
		)
		.sort((a, b) => a.element.startTime - b.element.startTime);
	return {
		...summary,
		total: selected.length,
		offset,
		items: selected
			.slice(offset, offset + limit)
			.map(({ trackId, element: e }) => ({
				trackId,
				id: e.id,
				name: e.name,
				type: e.type,
				startSeconds: e.startTime / 120000,
				durationSeconds: e.duration / 120000,
				sourceInSeconds: e.trimStart / 120000,
				...("mediaId" in e ? { mediaId: e.mediaId } : {}),
				...("definitionId" in e ? { definitionId: e.definitionId } : {}),
			})),
	};
}
