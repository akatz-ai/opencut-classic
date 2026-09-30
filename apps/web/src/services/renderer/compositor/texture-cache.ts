import type { ExternalTextureDescriptor } from "./types";
type PixelKey = Pick<
	ExternalTextureDescriptor,
	"source" | "version" | "width" | "height"
>;

export function sameExternalPixels({
	previous,
	next,
}: {
	previous: PixelKey;
	next: PixelKey;
}): boolean {
	return (
		previous.source === next.source &&
		previous.version === next.version &&
		previous.width === next.width &&
		previous.height === next.height
	);
}
