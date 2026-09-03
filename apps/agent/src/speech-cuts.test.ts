import { describe, expect, test } from "bun:test";
import { buildSpeechCutPlan } from "./speech-cuts";

describe("buildSpeechCutPlan", () => {
	test("maps source silence and filler words through edited timeline clips", () => {
		const plan = buildSpeechCutPlan({
			snapshot: {
				revision: "rev-1",
				project: { id: "project", fps: 10 },
				activeScene: {
					tracks: {
						main: {
							elements: [
								{
									type: "video",
									mediaId: "media",
									startTime: 0,
									duration: 1_200_000,
									trimStart: 600_000,
								},
							],
						},
					},
				},
			},
			mediaId: "media",
			words: [
				{ text: "hello", start: 5, end: 5.5 },
				{ text: "um", start: 6, end: 6.3 },
				{ text: "world", start: 7, end: 7.4 },
			],
			silences: [{ start: 8, end: 9, duration: 1 }],
		});

		expect(plan.ranges).toEqual([
			expect.objectContaining({
				startSeconds: 1,
				endSeconds: 1.3,
				reason: "filler: um",
			}),
			expect.objectContaining({
				startSeconds: 3.1,
				endSeconds: 10,
			}),
		]);
		expect(plan.totalRemovedSeconds).toBe(7.2);
	});
});
