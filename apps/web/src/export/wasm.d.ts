import "opencut-wasm";
declare module "opencut-wasm" {
	export function resolveExportDimensions(
		width: number,
		height: number,
		preset: string,
	): { width: number; height: number };
	export function fitExportFrame(
		width: number,
		height: number,
		outputWidth: number,
		outputHeight: number,
	): { width: number; height: number; x: number; y: number };
}
