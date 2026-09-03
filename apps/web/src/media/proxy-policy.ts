import type { MediaAsset } from "@/media/types";

const MAX_PROXY_WIDTH = 1280;
const MAX_PROXY_HEIGHT = 720;

export function shouldGeneratePreviewProxy({
	asset,
}: {
	asset: MediaAsset;
}): boolean {
	if (asset.type !== "video" || asset.proxy) return false;
	if (asset.canDecode === false) return true;
	return (
		(asset.width ?? 0) > MAX_PROXY_WIDTH ||
		(asset.height ?? 0) > MAX_PROXY_HEIGHT ||
		(asset.fps ?? 0) > 30
	);
}
