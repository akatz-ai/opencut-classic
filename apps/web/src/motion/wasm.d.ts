import "opencut-wasm";
import type { ClipMotion, MotionDelta } from "./types";
declare module "opencut-wasm" {
	export function fitMotion(value: unknown, duration: number): ClipMotion;
	export function splitMotion(
		value: unknown,
		left: number,
		right: number,
	): [ClipMotion, ClipMotion];
	export function evaluateMotion(
		value: unknown,
		localTime: number,
		clipDuration: number,
	): MotionDelta;
	export function validateMotionCut(
		outgoingEnd: number,
		incomingStart: number,
		availableHandle: number,
		duration: number,
	): void;
}
