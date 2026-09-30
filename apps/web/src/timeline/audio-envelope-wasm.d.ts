import "opencut-wasm";

declare module "opencut-wasm" {
	export function clampAudioFadeDuration(
		clipDuration: number,
		requestedDuration: number,
	): number;
	export function evaluateAudioFadeGain(
		clipDuration: number,
		localTime: number,
		fadeInDuration: number,
		fadeOutDuration: number,
	): number;
}
