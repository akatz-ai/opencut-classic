import { describe, expect, test } from "bun:test";
import { getTimelineHorizontalWheelDelta } from "@/timeline/components/interaction";

describe("timeline wheel interaction", () => {
	test("maps Alt plus vertical wheel up left and wheel down right", () => {
		expect(
			getTimelineHorizontalWheelDelta({
				altKey: true,
				shiftKey: false,
				deltaX: 0,
				deltaY: -120,
				deltaMode: 0,
			}),
		).toBe(-40);
		expect(
			getTimelineHorizontalWheelDelta({
				altKey: true,
				shiftKey: false,
				deltaX: 0,
				deltaY: 120,
				deltaMode: 0,
			}),
		).toBe(40);
	});

	test("normalizes line-mode wheels and preserves native horizontal input", () => {
		expect(
			getTimelineHorizontalWheelDelta({
				altKey: true,
				shiftKey: false,
				deltaX: 0,
				deltaY: 3,
				deltaMode: 1,
			}),
		).toBe(40);
		expect(
			getTimelineHorizontalWheelDelta({
				altKey: false,
				shiftKey: false,
				deltaX: -18,
				deltaY: 2,
				deltaMode: 0,
			}),
		).toBe(-18);
	});

	test("leaves an unmodified vertical wheel for track scrolling", () => {
		expect(
			getTimelineHorizontalWheelDelta({
				altKey: false,
				shiftKey: false,
				deltaX: 0,
				deltaY: 100,
				deltaMode: 0,
			}),
		).toBeNull();
	});
});
