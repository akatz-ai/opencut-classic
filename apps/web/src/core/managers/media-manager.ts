import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";
import { clearImageSourceCache } from "@/services/renderer/nodes/image-node";
import { shouldGeneratePreviewProxy } from "@/media/proxy-policy";
import {
	generateNativeProxy,
	getNativeMediaHealth,
} from "@/services/native-media/client";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();
	private proxyQueue: Promise<void> = Promise.resolve();

	constructor(private editor: EditorCore) {}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			this.editor.project.ratchetFpsForImportedMedia({
				importedAssets: [newAsset],
			});
			if (shouldGeneratePreviewProxy({ asset: newAsset })) {
				this.enqueuePreviewProxy({ projectId, mediaId: newAsset.id });
			}
			return newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	private enqueuePreviewProxy({
		projectId,
		mediaId,
	}: {
		projectId: string;
		mediaId: string;
	}): void {
		this.proxyQueue = this.proxyQueue.then(() =>
			this.generatePreviewProxy({ projectId, mediaId }),
		);
	}

	private async generatePreviewProxy({
		projectId,
		mediaId,
	}: {
		projectId: string;
		mediaId: string;
	}): Promise<void> {
		const asset = this.assets.find((candidate) => candidate.id === mediaId);
		if (!asset || asset.type !== "video" || asset.proxyState === "generating") {
			return;
		}
		const health = await getNativeMediaHealth();
		if (!health?.available) return;

		this.updateAsset({ mediaId, patch: { proxyState: "generating" } });
		try {
			const { response, metadata } = await generateNativeProxy({
				file: asset.file,
			});
			if (!response.body) throw new Error("Proxy response body is missing");
			const storageCheck = await storageService.canStoreFile({
				size: metadata.sizeBytes,
			});
			if (!storageCheck.canStore) {
				await response.body.cancel();
				throw new Error("Not enough browser storage for the preview proxy");
			}
			const proxyFile = await storageService.saveMediaProxy({
				projectId,
				mediaId,
				stream: response.body,
				width: metadata.width,
				height: metadata.height,
				hardwareEncoded: metadata.hardwareEncoded,
			});
			videoCache.clearVideo({ mediaId });
			this.updateAsset({
				mediaId,
				patch: {
					proxyState: "ready",
					proxy: {
						file: proxyFile,
						url: URL.createObjectURL(proxyFile),
						width: metadata.width,
						height: metadata.height,
						size: proxyFile.size,
						hardwareEncoded: metadata.hardwareEncoded,
					},
				},
			});
		} catch (error) {
			console.warn(`Failed to generate preview proxy for ${asset.name}:`, error);
			this.updateAsset({ mediaId, patch: { proxyState: "failed" } });
		}
	}

	private updateAsset({
		mediaId,
		patch,
	}: {
		mediaId: string;
		patch: Partial<MediaAsset>;
	}): void {
		this.assets = this.assets.map((asset) =>
			asset.id === mediaId ? { ...asset, ...patch } : asset,
		);
		this.notify();
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand({
						projectId,
						assetId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map(
							(id) =>
								new RemoveMediaAssetCommand({
									projectId,
									assetId: id,
								}),
						),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;
			this.notify();
			for (const asset of mediaAssets) {
				if (shouldGeneratePreviewProxy({ asset })) {
					this.enqueuePreviewProxy({ projectId, mediaId: asset.id });
				}
			}
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();
		clearImageSourceCache();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxy?.url) {
				URL.revokeObjectURL(asset.proxy.url);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();
		waveformCache.clearAll();
		clearImageSourceCache();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxy?.url) {
				URL.revokeObjectURL(asset.proxy.url);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
