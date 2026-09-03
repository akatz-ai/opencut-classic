import type { StorageAdapter } from "./types";

export class OPFSAdapter implements StorageAdapter<File> {
	private directoryName: string;

	constructor(directoryName = "media") {
		this.directoryName = directoryName;
	}

	private async getDirectory(): Promise<FileSystemDirectoryHandle> {
		const opfsRoot = await navigator.storage.getDirectory();
		return await opfsRoot.getDirectoryHandle(this.directoryName, {
			create: true,
		});
	}

	async get(key: string): Promise<File | null> {
		try {
			const directory = await this.getDirectory();
			const fileHandle = await directory.getFileHandle(key);
			return await fileHandle.getFile();
		} catch (error) {
			if (isNotFoundError(error)) {
				return null;
			}
			throw error;
		}
	}

	async set({
		key,
		value: file,
	}: {
		key: string;
		value: File;
	}): Promise<void> {
		const directory = await this.getDirectory();
		const fileHandle = await directory.getFileHandle(key, { create: true });
		const writable = await fileHandle.createWritable();

		await writable.write(file);
		await writable.close();
	}

	async setStream({
		key,
		stream,
	}: {
		key: string;
		stream: ReadableStream<Uint8Array>;
	}): Promise<File> {
		const directory = await this.getDirectory();
		const fileHandle = await directory.getFileHandle(key, { create: true });
		const writable = await fileHandle.createWritable();
		try {
			await stream.pipeTo(writable);
		} catch (error) {
			await writable.abort().catch(() => undefined);
			await directory.removeEntry(key).catch(() => undefined);
			throw error;
		}
		return await fileHandle.getFile();
	}

	async remove(key: string): Promise<void> {
		try {
			const directory = await this.getDirectory();
			await directory.removeEntry(key);
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	async list(): Promise<string[]> {
		const directory = await this.getDirectory();
		const keys: string[] = [];

		for await (const name of directory.keys()) {
			keys.push(name);
		}

		return keys;
	}

	async clear(): Promise<void> {
		const directory = await this.getDirectory();

		for await (const name of directory.keys()) {
			await directory.removeEntry(name);
		}
	}

	// Helper method to check OPFS support
	static isSupported(): boolean {
		return "storage" in navigator && "getDirectory" in navigator.storage;
	}
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "NotFoundError"
	);
}
