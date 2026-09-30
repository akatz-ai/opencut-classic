import type { TransitionKind } from "./types";

export const TRANSITION_MIME = "application/x-opencut-transition";
export const TRANSITION_PRESETS = [
	{ kind: "fade", label: "Dissolve", category: "Basic" },
	{ kind: "slide-left", label: "Slide left", category: "Slide" },
	{ kind: "slide-right", label: "Slide right", category: "Slide" },
	{ kind: "slide-up", label: "Slide up", category: "Slide" },
	{ kind: "slide-down", label: "Slide down", category: "Slide" },
	{ kind: "pop", label: "Pop", category: "Zoom" },
] satisfies { kind: TransitionKind; label: string; category: string }[];

export function isTransitionKind(value: string): value is TransitionKind {
	return TRANSITION_PRESETS.some((preset) => preset.kind === value);
}

export function transitionLabel(kind: TransitionKind) {
	return TRANSITION_PRESETS.find((preset) => preset.kind === kind)!.label;
}
