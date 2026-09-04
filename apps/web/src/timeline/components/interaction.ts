export const TIMELINE_DRAG_THRESHOLD_PX = 5;
export const TIMELINE_HORIZONTAL_WHEEL_STEP_PX = 40;
export const TIMELINE_ZOOM_BUTTON_FACTOR = 1.7;
export const TIMELINE_ZOOM_ANCHOR_PLAYHEAD_THRESHOLD = 0.15;

export function getTimelineHorizontalWheelDelta({
	altKey,
	shiftKey,
	deltaX,
	deltaY,
	deltaMode,
}: {
	altKey: boolean;
	shiftKey: boolean;
	deltaX: number;
	deltaY: number;
	deltaMode: number;
}): number | null {
	const isHorizontal =
		altKey || shiftKey || Math.abs(deltaX) > Math.abs(deltaY);
	if (!isHorizontal) return null;

	// Resolve-style Alt+wheel always maps the physical vertical wheel direction:
	// wheel up moves left, wheel down moves right. Native horizontal/Shift-wheel
	// input retains its dominant axis behavior.
	const raw =
		altKey && deltaY !== 0
			? deltaY
			: Math.abs(deltaX) > Math.abs(deltaY)
				? deltaX
				: deltaY;
	const normalized =
		deltaMode === 1
			? raw * 16
			: deltaMode === 2
				? Math.sign(raw) * TIMELINE_HORIZONTAL_WHEEL_STEP_PX
				: raw;
	return (
		Math.sign(normalized) *
		Math.min(Math.abs(normalized), TIMELINE_HORIZONTAL_WHEEL_STEP_PX)
	);
}
