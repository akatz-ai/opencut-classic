import { expect, test } from "bun:test";
import { sameExternalPixels } from "./texture-cache";

test("a reused decoder canvas with new pixels must upload again", () => {
	const previous = {
		source: new OffscreenCanvas(10, 10),
		version: 0,
		width: 10,
		height: 10,
	};
	expect(
		sameExternalPixels({ previous, next: { ...previous, version: 0.5 } }),
	).toBe(false);
	expect(sameExternalPixels({ previous, next: { ...previous } })).toBe(true);
});
test("static assets retain cache hits while changed graphics invalidate", () => {
	const previous = {
		source: new OffscreenCanvas(10, 10),
		width: 10,
		height: 10,
	};
	expect(sameExternalPixels({ previous, next: previous })).toBe(true);
	expect(
		sameExternalPixels({ previous, next: { ...previous, width: 20 } }),
	).toBe(false);
	expect(
		sameExternalPixels({
			previous: { ...previous, version: "cyan" },
			next: { ...previous, version: "magenta" },
		}),
	).toBe(false);
});
