import * as opencutWasm from "opencut-wasm";
import type { EffectPass, EffectUniformValue } from "@/effects/types";

let gpuAvailable = false;
let gpuBackend = "unavailable";
let initPromise: Promise<void> | null = null;

declare global {
	interface Window {
		__opencutGpuBackend?: string;
	}
}

export function initializeGpuRenderer(): Promise<void> {
	if (!initPromise) {
		initPromise = opencutWasm
			.initializeGpu()
			.then(() => {
				gpuAvailable = true;
				const readBackend = Reflect.get(opencutWasm, "getGpuBackend");
				gpuBackend =
					typeof readBackend === "function" ? String(readBackend()) : "unknown";
				window.__opencutGpuBackend = gpuBackend;
			})
			.catch((error: unknown) => {
				gpuAvailable = false;
				gpuBackend = "unavailable";
				window.__opencutGpuBackend = gpuBackend;
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`GPU renderer unavailable: ${message}`);
			});
	}
	return initPromise;
}

export function isGpuAvailable(): boolean {
	return gpuAvailable;
}

export function getGpuBackend(): string {
	return gpuBackend;
}

export const gpuRenderer = {
	applyEffect({
		source,
		width,
		height,
		passes,
	}: {
		source: OffscreenCanvas;
		width: number;
		height: number;
		passes: EffectPass[];
	}): OffscreenCanvas {
		if (passes.length === 0 || !gpuAvailable) {
			return source;
		}

		return opencutWasm.applyEffectPasses({
			source,
			width,
			height,
			passes: serializeEffectPasses(passes),
		});
	},

	applyMaskFeather({
		maskCanvas,
		width,
		height,
		feather,
	}: {
		maskCanvas: OffscreenCanvas;
		width: number;
		height: number;
		feather: number;
	}): OffscreenCanvas {
		if (!gpuAvailable) {
			return maskCanvas;
		}

		return opencutWasm.applyMaskFeather({
			mask: maskCanvas,
			width,
			height,
			feather,
		});
	},
};

function serializeEffectPasses(passes: EffectPass[]) {
	return passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.entries(pass.uniforms).map(([name, value]) => ({
			name,
			value: normalizeUniformValue(value),
		})),
	}));
}

function normalizeUniformValue(value: EffectUniformValue): number[] {
	return typeof value === "number" ? [value] : value;
}
