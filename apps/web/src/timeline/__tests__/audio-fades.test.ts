import { describe, expect, test } from "bun:test";
import {
	buildAudioGainAutomation,
	hasAudioEnvelope,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import type { AudioElement, SceneTracks, UploadAudioElement } from "@/timeline";
import { mediaTime, mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

function buildAudioElement(
	overrides: Partial<UploadAudioElement> = {},
): AudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		name: "Audio 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { volume: 0, muted: false },
		...overrides,
	};
}

function buildTracks(element: AudioElement): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [],
		},
		audio: [
			{
				id: "audio-track",
				type: "audio",
				name: "Audio",
				muted: false,
				elements: [element],
			},
		],
	};
}

describe("audio clip fades", () => {
	test("fade handles affect the shared playback and export gain", () => {
		const element = buildAudioElement({
			fadeInDuration: mediaTimeFromSeconds({ seconds: 2 }),
			fadeOutDuration: mediaTimeFromSeconds({ seconds: 3 }),
		});
		expect(hasAudioEnvelope({ element })).toBe(true);
		expect(resolveEffectiveAudioGain({ element, localTime: 0 })).toBe(0);
		expect(resolveEffectiveAudioGain({ element, localTime: 1 })).toBeCloseTo(
			0.5,
		);
		expect(resolveEffectiveAudioGain({ element, localTime: 5 })).toBe(1);
		expect(resolveEffectiveAudioGain({ element, localTime: 8.5 })).toBeCloseTo(
			0.5,
		);
		expect(resolveEffectiveAudioGain({ element, localTime: 10 })).toBe(0);
	});

	test("fade gain multiplies the existing volume envelope", () => {
		const element = buildAudioElement({
			params: { volume: -6, muted: false },
			fadeInDuration: mediaTimeFromSeconds({ seconds: 2 }),
		});
		const baseGain = 10 ** (-6 / 20);
		expect(resolveEffectiveAudioGain({ element, localTime: 1 })).toBeCloseTo(
			baseGain * 0.5,
		);
	});

	test("gain automation includes exact silent boundaries", () => {
		const element = buildAudioElement({
			fadeInDuration: mediaTimeFromSeconds({ seconds: 1 }),
			fadeOutDuration: mediaTimeFromSeconds({ seconds: 1 }),
		});
		const points = buildAudioGainAutomation({
			element,
			fromLocalTime: 0,
			toLocalTime: 10,
			stepSeconds: 0.5,
		});
		expect(points[0]).toEqual({ localTime: 0, gain: 0 });
		expect(points.at(-1)).toEqual({ localTime: 10, gain: 0 });
	});

	test("shortening a clip clamps both fade durations", () => {
		const element = buildAudioElement({
			fadeInDuration: mediaTimeFromSeconds({ seconds: 4 }),
			fadeOutDuration: mediaTimeFromSeconds({ seconds: 5 }),
		});
		const nextDuration = mediaTimeFromSeconds({ seconds: 3 });
		const updated = applyElementUpdate({
			element,
			patch: { duration: nextDuration },
			context: { tracks: buildTracks(element), trackId: "audio-track" },
		});
		expect(updated.type).toBe("audio");
		if (updated.type !== "audio") throw new Error("Expected audio element");
		expect(updated.fadeInDuration).toBe(nextDuration);
		expect(updated.fadeOutDuration).toBe(nextDuration);
		expect(Number.isInteger(updated.fadeInDuration)).toBe(true);
		expect(updated.fadeInDuration).not.toBe(mediaTime({ ticks: 0 }));
	});
});
