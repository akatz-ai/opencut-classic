import { clampAudioFadeDuration } from "opencut-wasm";
import type { AudioElement } from "./types";
import { roundMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function readFadeDuration({
	value,
	duration,
}: {
	value: MediaTime | undefined;
	duration: MediaTime;
}): MediaTime {
	return roundMediaTime({
		time: clampAudioFadeDuration(duration, value ?? ZERO_MEDIA_TIME),
	});
}

export function getAudioFadeInDuration({
	element,
}: {
	element: AudioElement;
}): MediaTime {
	return readFadeDuration({
		value: element.fadeInDuration,
		duration: element.duration,
	});
}

export function getAudioFadeOutDuration({
	element,
}: {
	element: AudioElement;
}): MediaTime {
	return readFadeDuration({
		value: element.fadeOutDuration,
		duration: element.duration,
	});
}

export function clampAudioFadesToDuration({
	element,
}: {
	element: AudioElement;
}): AudioElement {
	return {
		...element,
		fadeInDuration: getAudioFadeInDuration({ element }),
		fadeOutDuration: getAudioFadeOutDuration({ element }),
	};
}
