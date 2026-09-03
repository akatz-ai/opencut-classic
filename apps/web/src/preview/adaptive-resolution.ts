import type { TCanvasSize } from "@/project/types";

export const PREVIEW_RESOLUTION_MODES = [
	"auto",
	"full",
	"half",
	"quarter",
] as const;

export type PreviewResolutionMode =
	(typeof PREVIEW_RESOLUTION_MODES)[number];

export function isPreviewResolutionMode(
	value: string,
): value is PreviewResolutionMode {
	return PREVIEW_RESOLUTION_MODES.some((mode) => mode === value);
}

const AUTO_RESOLUTION_SCALES = [0.25, 0.5, 0.75, 1] as const;
const AUTO_OVERSCAN = 1.15;

function makeEven(value: number): number {
	const rounded = Math.max(2, Math.round(value));
	return rounded % 2 === 0 ? rounded : rounded + 1;
}

function sizeAtScale({
	canvasSize,
	scale,
}: {
	canvasSize: TCanvasSize;
	scale: number;
}): TCanvasSize {
	return {
		width: makeEven(canvasSize.width * scale),
		height: makeEven(canvasSize.height * scale),
	};
}

/**
 * Chooses a stable, quantized render size for the interactive preview.
 *
 * Auto mode renders enough physical pixels to cover the fitted viewport at the
 * current device pixel ratio, plus a small overscan margin. Quantized tiers
 * prevent every panel resize from rebuilding the WebGPU surface and decoders.
 */
export function getPreviewRenderSize({
	canvasSize,
	viewportSize,
	devicePixelRatio = 1,
	mode,
}: {
	canvasSize: TCanvasSize;
	viewportSize: TCanvasSize;
	devicePixelRatio?: number;
	mode: PreviewResolutionMode;
}): TCanvasSize {
	if (mode === "full") return { ...canvasSize };
	if (mode === "half") return sizeAtScale({ canvasSize, scale: 0.5 });
	if (mode === "quarter") return sizeAtScale({ canvasSize, scale: 0.25 });

	const safeDpr = Math.max(1, Math.min(devicePixelRatio, 3));
	const viewportWidth = Math.max(1, viewportSize.width);
	const viewportHeight = Math.max(1, viewportSize.height);
	const fitScale = Math.min(
		viewportWidth / canvasSize.width,
		viewportHeight / canvasSize.height,
	);
	const desiredScale = Math.min(1, fitScale * safeDpr * AUTO_OVERSCAN);
	const scale =
		AUTO_RESOLUTION_SCALES.find((candidate) => candidate >= desiredScale) ?? 1;

	return sizeAtScale({ canvasSize, scale });
}
