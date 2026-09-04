import { describe, expect, test } from "bun:test";
import {
	buildTranscriptSegments,
	joinTranscriptWords,
	mapSourceWordsToTimeline,
	normalizeHyperframesTranscript,
	normalizeRemoteTranscription,
	presentTranscriptionResult,
	transcriptionCacheKey,
} from "./transcription";

describe("transcription", () => {
	test("normalizes HyperFrames words and reconstructs readable punctuation", () => {
		const words = normalizeHyperframesTranscript({
			value: [
				{ text: "Hello", start: 0.1, end: 0.4 },
				{ text: "world,", start: 0.5, end: 0.9 },
				{ text: "again.", start: 2.2, end: 2.7 },
			],
		});
		expect(joinTranscriptWords(words)).toBe("Hello world, again.");
		expect(buildTranscriptSegments(words)).toEqual([
			{ text: "Hello world,", start: 0.1, end: 0.9 },
			{ text: "again.", start: 2.2, end: 2.7 },
		]);
	});

	test("normalizes OpenAI-compatible verbose timestamp output", () => {
		expect(
			normalizeRemoteTranscription({
				value: {
					text: "Hello world.",
					words: [
						{ word: "Hello", start: 0.1, end: 0.4 },
						{ word: "world.", start: 0.5, end: 0.9 },
					],
					segments: [{ text: "Hello world.", start: 0.1, end: 0.9 }],
				},
			}),
		).toEqual({
			text: "Hello world.",
			words: [
				{ text: "Hello", start: 0.1, end: 0.4 },
				{ text: "world.", start: 0.5, end: 0.9 },
			],
			segments: [{ text: "Hello world.", start: 0.1, end: 0.9 }],
		});
	});

	test("maps source timestamps through trims, cuts, retimes, and mute state", () => {
		const timeline = mapSourceWordsToTimeline({
			mediaId: "media-1",
			words: [
				{ text: "first", start: 1.2, end: 1.6 },
				{ text: "removed", start: 4, end: 4.4 },
				{ text: "fast", start: 5.4, end: 6 },
			],
			snapshot: {
				revision: "revision-1",
				activeScene: {
					tracks: {
						main: {
							elements: [
								{
									id: "clip-1",
									type: "video",
									mediaId: "media-1",
									startTime: 0,
									duration: 240_000,
									trimStart: 120_000,
									params: { muted: false },
								},
								{
									id: "clip-2",
									type: "video",
									mediaId: "media-1",
									startTime: 240_000,
									duration: 120_000,
									trimStart: 600_000,
									retime: { rate: 2 },
									params: { muted: false },
								},
							],
						},
						overlay: [
							{
								muted: true,
								elements: [
									{
										id: "muted-clip",
										type: "video",
										mediaId: "media-1",
										startTime: 0,
										duration: 840_000,
										trimStart: 0,
									},
								],
							},
						],
					},
				},
			},
		});
		expect(timeline.text).toBe("first fast");
		expect(timeline.clipCount).toBe(2);
		expect(timeline.words.map((word) => word.text)).toEqual(["first", "fast"]);
		expect(timeline.words[0]!.start).toBeCloseTo(0.2);
		expect(timeline.words[0]!.end).toBeCloseTo(0.6);
		expect(timeline.words[1]!.start).toBeCloseTo(2.2);
		expect(timeline.words[1]!.end).toBeCloseTo(2.5);
	});

	test("keys the durable cache by source metadata and backend", () => {
		const media = {
			id: "media-1",
			name: "source.mp4",
			type: "video",
			sizeBytes: 123,
			durationSeconds: 10,
		};
		const first = transcriptionCacheKey({
			media,
			backend: {
				kind: "local",
				engine: "hyperframes/whisper.cpp",
				model: "small.en",
				language: "en",
			},
		});
		const repeated = transcriptionCacheKey({
			media,
			backend: {
				kind: "local",
				engine: "hyperframes/whisper.cpp",
				model: "small.en",
				language: "en",
			},
		});
		const differentModel = transcriptionCacheKey({
			media,
			backend: {
				kind: "local",
				engine: "hyperframes/whisper.cpp",
				model: "medium.en",
				language: "en",
			},
		});
		expect(first).toBe(repeated);
		expect(first).not.toBe(differentModel);
	});

	test("keeps default tool output compact while retaining timeline timestamps", () => {
		const presented = presentTranscriptionResult({
			result: {
				cacheHit: true,
				selectedAutomatically: true,
				transcriptPath: "/data/transcript.json",
				transcript: {
					schemaVersion: 1,
					createdAt: "2026-09-04T00:00:00.000Z",
					timeBasis: "source-media-seconds",
					projectId: "project-1",
					sourceProjectRevision: "revision-1",
					media: {
						id: "media-1",
						name: "source.mp4",
						type: "video",
						sizeBytes: 123,
					},
					backend: {
						kind: "local",
						engine: "hyperframes/whisper.cpp",
						model: "small.en",
					},
					durationSeconds: 1,
					text: "Hello.",
					words: [{ text: "Hello.", start: 0.1, end: 0.8 }],
					segments: [{ text: "Hello.", start: 0.1, end: 0.8 }],
				},
				timeline: {
					timeBasis: "project-timeline-seconds",
					projectRevision: "revision-1",
					mediaId: "media-1",
					clipCount: 1,
					text: "Hello.",
					words: [
						{
							text: "Hello.",
							start: 0.1,
							end: 0.8,
							mediaId: "media-1",
							clipId: "clip-1",
							sourceStart: 0.1,
							sourceEnd: 0.8,
						},
					],
					segments: [{ text: "Hello.", start: 0.1, end: 0.8 }],
				},
				note: "Review only",
			},
		});
		expect(presented.detail).toBe("segments");
		expect(presented.timeline).toEqual({
			timeBasis: "project-timeline-seconds",
			projectRevision: "revision-1",
			mediaId: "media-1",
			clipCount: 1,
			wordCount: 1,
			segmentCount: 1,
			segments: [{ text: "Hello.", start: 0.1, end: 0.8 }],
		});
		expect(JSON.stringify(presented)).not.toContain("sourceStart");
	});
});
