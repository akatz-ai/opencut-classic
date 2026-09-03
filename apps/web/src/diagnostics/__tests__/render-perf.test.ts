import { afterEach, describe, expect, test } from "bun:test";
import {
	getRenderPerfSnapshot,
	incrementCounter,
	onRenderPerfFrameComplete,
	recordSpan,
	resetRenderPerf,
} from "@/diagnostics/render-perf";

const originalWindow = globalThis.window;

afterEach(() => {
	resetRenderPerf();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: originalWindow,
		writable: true,
	});
});

describe("render performance diagnostics", () => {
	test("exposes span percentiles and per-frame counters", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { __renderPerf: true },
			writable: true,
		});
		resetRenderPerf();

		recordSpan({ name: "render", durationMs: 2 });
		recordSpan({ name: "render", durationMs: 6 });
		incrementCounter({ name: "upload", by: 3 });
		onRenderPerfFrameComplete();

		expect(getRenderPerfSnapshot()).toEqual({
			frames: 1,
			spans: [
				{
					span: "render",
					count: 2,
					meanMs: 4,
					p50Ms: 6,
					p95Ms: 6,
					maxMs: 6,
				},
			],
			counters: [
				{
					counter: "upload",
					perFrame: 3,
					total: 3,
					frames: 1,
				},
			],
		});
	});
});
