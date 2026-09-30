/** Decoders are mutable cursors: two clips may read the same file at different
 * source times in a single composite. Keep their cursor/pool/prefetch separate.
 * The media prefix is retained so clearVideo invalidates every clip and proxy. */
export function getVideoSinkKey({
	mediaId,
	maxSourceSize,
	decodeStreamId,
}: {
	mediaId: string;
	maxSourceSize?: number;
	decodeStreamId?: string;
}): string {
	const sizeKey = maxSourceSize
		? `${mediaId}@${Math.max(2, Math.round(maxSourceSize))}`
		: mediaId;
	return decodeStreamId
		? `${sizeKey}@stream:${encodeURIComponent(decodeStreamId)}`
		: sizeKey;
}
