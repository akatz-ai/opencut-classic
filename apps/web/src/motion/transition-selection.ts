import { create } from "zustand";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import type { ElementRef } from "@/timeline";
import type { ClipTransition } from "./types";
import { getCutPostRoll, validateClipMotion } from ".";

export type MotionEdge = "cut" | "enter" | "exit";
export type MotionTarget = ElementRef & { edge: MotionEdge };

// UI-only selection, tied to the exact element-selection snapshot. Clicking a
// clip again, switching scenes, or selecting keyframes invalidates it.
export const useTransitionSelectionStore = create<{
	target: MotionTarget | null;
	selection: ElementRef[] | null;
}>(() => ({ target: null, selection: null }));

export function selectTransition({
	editor,
	target,
}: {
	editor: EditorCore;
	target: MotionTarget;
}) {
	editor.selection.setSelectedElements({
		elements: [{ trackId: target.trackId, elementId: target.elementId }],
	});
	useTransitionSelectionStore.setState({
		target,
		selection: editor.selection.getSelectedElements(),
	});
}

export function getSelectedTransition(editor: EditorCore): MotionTarget | null {
	const state = useTransitionSelectionStore.getState();
	if (
		state.selection !== editor.selection.getSelectedElements() ||
		editor.selection.getActiveSelectionKind() !== "elements" ||
		!state.target ||
		!editor.timeline.getElementsWithTracks({ elements: [state.target] }).length
	)
		return null;
	return state.target;
}

export function useSelectedTransition() {
	const editor = useEditor();
	useTransitionSelectionStore();
	useEditor((e) => [
		e.selection.getSelectedElements(),
		e.selection.getActiveSelectionKind(),
		e.scenes.getActiveSceneOrNull()?.tracks,
	]);
	return getSelectedTransition(editor);
}

/** UI command adapter; the shared Rust motion engine validates every edit. */
export function updateTransition({
	editor,
	target,
	transition,
}: {
	editor: EditorCore;
	target: MotionTarget;
	transition?: ClipTransition;
}) {
	const found = editor.timeline.getElementsWithTracks({
		elements: [target],
	})[0];
	if (
		!found ||
		found.element.type === "audio" ||
		found.element.type === "effect"
	)
		throw new Error("Select a visual clip first.");
	const { element, track } = found;
	const key = target.edge === "exit" ? "exit" : "enter";
	const motion = { ...element.motion };
	if (transition) motion[key] = transition;
	else delete motion[key];
	if (key === "enter")
		motion.fromPrevious = target.edge === "cut" && !!transition;
	validateClipMotion({ motion, duration: element.duration });
	if (motion.fromPrevious) {
		const sorted = [...track.elements].sort(
			(a, b) => a.startTime - b.startTime,
		);
		getCutPostRoll({
			previous: sorted[sorted.findIndex((e) => e.id === element.id) - 1],
			incoming: { ...element, motion },
		});
	}
	editor.timeline.updateElements({
		updates: [{ trackId: track.id, elementId: element.id, patch: { motion } }],
	});
}

export function removeSelectedTransition(editor: EditorCore): boolean {
	const target = getSelectedTransition(editor);
	if (!target) return false;
	updateTransition({ editor, target });
	useTransitionSelectionStore.setState({ target: null, selection: null });
	editor.selection.clearSelection();
	return true;
}
