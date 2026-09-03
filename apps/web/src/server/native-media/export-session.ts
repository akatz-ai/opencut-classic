import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readWebStream } from "@/server/native-media/streams";

const SESSION_ID = /^[0-9a-f-]{36}$/;
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

function sessionRoot(): string {
	return process.env.OPENCUT_NATIVE_MEDIA_DIR ?? join(tmpdir(), "opencut-exports");
}

export async function createExportSession(): Promise<string> {
	const id = randomUUID();
	await mkdir(exportSessionPath(id), { recursive: true });
	return id;
}

export function exportSessionPath(id: string): string {
	if (!SESSION_ID.test(id)) throw new Error("Invalid native export session");
	return join(sessionRoot(), id);
}

export async function requireExportSession(id: string): Promise<string> {
	const path = exportSessionPath(id);
	await access(path);
	return path;
}

export async function removeExportSession(id: string): Promise<void> {
	await rm(exportSessionPath(id), { recursive: true, force: true });
}

export async function writeVideoChunk({
	sessionId,
	offset,
	body,
}: {
	sessionId: string;
	offset: number;
	body: ReadableStream<Uint8Array> | null;
}): Promise<void> {
	if (!body) throw new Error("Video chunk is missing");
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("Invalid video chunk offset");
	}
	const directory = await requireExportSession(sessionId);
	const path = join(directory, "video.mp4");
	const handle = await open(path, "r+").catch(async (error: unknown) => {
		if (isNotFoundError(error)) return await open(path, "w+");
		throw error;
	});
	let position = offset;
	try {
		for await (const chunk of readWebStream(body)) {
			await handle.write(chunk, 0, chunk.byteLength, position);
			position += chunk.byteLength;
		}
	} finally {
		await handle.close();
	}
}

export function sourcePath({
	sessionId,
	sourceId,
}: {
	sessionId: string;
	sourceId: string;
}): string {
	if (!SOURCE_ID.test(sourceId)) throw new Error("Invalid audio source ID");
	return join(exportSessionPath(sessionId), `source-${sourceId}.media`);
}

export async function writeAudioSource({
	sessionId,
	sourceId,
	body,
}: {
	sessionId: string;
	sourceId: string;
	body: ReadableStream<Uint8Array> | null;
}): Promise<void> {
	if (!body) throw new Error("Audio source is missing");
	await requireExportSession(sessionId);
	await pipeline(
		Readable.from(readWebStream(body)),
		createWriteStream(sourcePath({ sessionId, sourceId })),
	);
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
