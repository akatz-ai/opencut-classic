import { mock } from "bun:test";
import * as opencutWasm from "../../../rust/wasm/pkg-node/opencut_wasm.js";

mock.module("opencut-wasm", () => opencutWasm);

if (typeof globalThis.OffscreenCanvas === "undefined") {
	class TestOffscreenCanvas {
		constructor(width, height) {
			this.width = width;
			this.height = height;
		}

		getContext(type) {
			if (type !== "2d") return null;
			return {
				font: "",
				letterSpacing: "0px",
				textBaseline: "alphabetic",
				save() {},
				restore() {},
				measureText(text) {
					return {
						width: text.length * 10,
						actualBoundingBoxAscent: 8,
						actualBoundingBoxDescent: 2,
					};
				},
			};
		}
	}

	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: TestOffscreenCanvas,
		writable: true,
	});
}
