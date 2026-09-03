import type { MediaAssetData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export interface MediaProxyMetadata {
	storageKey: string;
	width: number;
	height: number;
	size: number;
	hardwareEncoded: boolean;
}

export interface MediaProxy extends Omit<MediaProxyMetadata, "storageKey"> {
	file: File;
	url: string;
}

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified" | "proxy"> {
	file: File;
	url?: string;
	codec?: string;
	canDecode?: boolean;
	proxy?: MediaProxy;
	proxyState?: "generating" | "ready" | "failed";
}
