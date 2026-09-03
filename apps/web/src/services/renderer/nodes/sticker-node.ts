import { resolveStickerId } from "@/stickers";
import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";
import { LruCache } from "@/services/cache/lru-cache";

export interface StickerNodeParams extends VisualNodeParams {
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}

interface CachedStickerSource {
	source: HTMLImageElement;
	width: number;
	height: number;
}

const stickerSourceCache = new LruCache<string, Promise<CachedStickerSource>>({
	maxEntries: 128,
});

export function loadStickerSource({
	stickerId,
}: {
	stickerId: string;
}): Promise<CachedStickerSource> {
	const cached = stickerSourceCache.get(stickerId);
	if (cached) return cached;

	const promise = (async (): Promise<CachedStickerSource> => {
		const url = resolveStickerId({
			stickerId,
			options: { width: 200, height: 200 },
		});

		const image = new Image();

		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () =>
				reject(new Error(`Failed to load sticker: ${stickerId}`));
			image.src = url;
		});

		return {
			source: image,
			width: image.naturalWidth,
			height: image.naturalHeight,
		};
	})().catch((error) => {
		stickerSourceCache.delete(stickerId);
		throw error;
	});

	stickerSourceCache.set({ key: stickerId, value: promise });
	return promise;
}

export class StickerNode extends VisualNode<
	StickerNodeParams,
	ResolvedVisualSourceNodeState
> {}
