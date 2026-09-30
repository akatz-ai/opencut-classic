import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
	outputWidth?: number;
	outputHeight?: number;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	outputWidth: number;
	outputHeight: number;
	fps: FrameRate;

	constructor({
		width,
		height,
		fps,
		outputWidth = width,
		outputHeight = height,
	}: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.outputWidth = outputWidth;
		this.outputHeight = outputHeight;
		this.fps = fps;

		const surface = createCanvasSurface({
			width: outputWidth,
			height: outputHeight,
		});
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.outputWidth,
			height: this.outputHeight,
		});
		return wasmCompositor.getCanvas();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;
		this.outputWidth = width;
		this.outputHeight = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async render({
		node,
		time,
		completeFrame = true,
	}: {
		node: AnyBaseNode;
		time: number;
		completeFrame?: boolean;
	}) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: this.outputWidth,
			height: this.outputHeight,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
		if (completeFrame) {
			onRenderPerfFrameComplete();
		}
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
		destinationRect,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement | OffscreenCanvas;
		destinationRect?: { x: number; y: number; width: number; height: number };
	}) {
		await this.render({ node, time, completeFrame: false });

		const ctx =
			targetCanvas instanceof OffscreenCanvas
				? targetCanvas.getContext("2d")
				: targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}
		// Export can target an exact social frame with a different aspect ratio.
		// Center the fully rendered project at output resolution, preserving its shape.
		if (destinationRect) {
			ctx.fillStyle = "#000";
			ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
		}

		measureSpanSync({
			name: "drawImage",
			fn: () =>
				ctx.drawImage(
					wasmCompositor.getCanvas(),
					destinationRect?.x ?? 0,
					destinationRect?.y ?? 0,
					destinationRect?.width ?? targetCanvas.width,
					destinationRect?.height ?? targetCanvas.height,
				),
		});
		onRenderPerfFrameComplete();
	}
}
