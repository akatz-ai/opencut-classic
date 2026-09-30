export type TransitionKind =
	| "fade"
	| "slide-left"
	| "slide-right"
	| "slide-up"
	| "slide-down"
	| "pop";
export interface ClipTransition {
	kind: TransitionKind;
	/** Timeline ticks, not seconds. */
	duration: number;
	easing: "linear" | "smooth";
}
export interface ClipMotion {
	enter?: ClipTransition;
	exit?: ClipTransition;
	fromPrevious?: boolean;
}
export interface MotionDelta {
	x: number;
	y: number;
	scale: number;
	opacity: number;
}
