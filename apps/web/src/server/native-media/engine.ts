import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { readWebStream } from "@/server/native-media/streams";

const MAX_CAPTURE_BYTES = 1024 * 1024;

export async function resolveMediaEngineBinary(): Promise<string> {
	const candidates = [
		process.env.OPENCUT_MEDIA_ENGINE_BIN,
		resolve(process.cwd(), "../../target/release/opencut-media-engine"),
		resolve(process.cwd(), "target/release/opencut-media-engine"),
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Continue through the supported binary locations.
		}
	}

	throw new Error(
		"OpenCut media engine is unavailable. Build it with cargo build --release -p opencut-media-engine.",
	);
}

export async function runMediaEngine({
	args,
}: {
	args: string[];
}): Promise<string> {
	const binary = await resolveMediaEngineBinary();
	return await new Promise((resolveRun, rejectRun) => {
		const child = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let capturedStdout = 0;
		let capturedStderr = 0;

		child.stdout.on("data", (chunk: Buffer) => {
			if (capturedStdout >= MAX_CAPTURE_BYTES) return;
			stdout.push(chunk);
			capturedStdout += chunk.length;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (capturedStderr >= MAX_CAPTURE_BYTES) return;
			stderr.push(chunk);
			capturedStderr += chunk.length;
		});
		child.on("error", rejectRun);
		child.on("close", (code) => {
			const output = Buffer.concat(stdout).toString("utf8").trim();
			if (code === 0) {
				resolveRun(output);
				return;
			}
			const error = Buffer.concat(stderr).toString("utf8").trim();
			rejectRun(new Error(error || `Media engine exited with code ${code}`));
		});
	});
}

type StreamingMediaEngine = {
	child: ReturnType<typeof spawn>;
	stdin: Writable;
	completion: Promise<void>;
};

const streamingMediaEngines = new Map<string, StreamingMediaEngine>();

export async function startMediaEngineStream({
	key,
	args,
}: {
	key: string;
	args: string[];
}): Promise<void> {
	if (streamingMediaEngines.has(key)) {
		throw new Error("Streaming media engine already exists");
	}
	const binary = await resolveMediaEngineBinary();
	const child = spawn(binary, args, {
		stdio: ["pipe", "ignore", "pipe"],
	});
	if (!child.stdin || !child.stderr) {
		child.kill("SIGTERM");
		throw new Error("Failed to open streaming media engine pipes");
	}
	const stderr: Buffer[] = [];
	let capturedStderr = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		if (capturedStderr >= MAX_CAPTURE_BYTES) return;
		stderr.push(chunk);
		capturedStderr += chunk.length;
	});
	const completion = new Promise<void>((resolveRun, rejectRun) => {
		child.on("error", rejectRun);
		child.on("close", (code) => {
			if (code === 0) {
				resolveRun();
				return;
			}
			const error = Buffer.concat(stderr).toString("utf8").trim();
			rejectRun(new Error(error || `Media engine exited with code ${code}`));
		});
	});
	void completion.catch(() => undefined);
	streamingMediaEngines.set(key, { child, stdin: child.stdin, completion });
}

export async function appendMediaEngineStream({
	key,
	body,
}: {
	key: string;
	body: ReadableStream<Uint8Array> | null;
}): Promise<void> {
	if (!body) throw new Error("Streaming media body is missing");
	const session = streamingMediaEngines.get(key);
	if (!session) throw new Error("Streaming media engine does not exist");
	for await (const chunk of readWebStream(body)) {
		await new Promise<void>((resolveWrite, rejectWrite) => {
			session.stdin.write(chunk, (error) => {
				if (error) rejectWrite(error);
				else resolveWrite();
			});
		});
	}
}

export async function finishMediaEngineStream({
	key,
}: {
	key: string;
}): Promise<void> {
	const session = streamingMediaEngines.get(key);
	if (!session) throw new Error("Streaming media engine does not exist");
	try {
		await new Promise<void>((resolveEnd, rejectEnd) => {
			session.stdin.end((error?: Error | null) => {
				if (error) rejectEnd(error);
				else resolveEnd();
			});
		});
		await session.completion;
	} finally {
		streamingMediaEngines.delete(key);
	}
}

export async function cancelMediaEngineStream({
	key,
}: {
	key: string;
}): Promise<void> {
	const session = streamingMediaEngines.get(key);
	if (!session) return;
	streamingMediaEngines.delete(key);
	session.stdin.destroy();
	session.child.kill("SIGTERM");
	await session.completion.catch(() => undefined);
}

export async function createNativeWorkspace({
	prefix,
}: {
	prefix: string;
}): Promise<string> {
	return await mkdtemp(join(tmpdir(), `opencut-${prefix}-`));
}

export async function removeNativeWorkspace(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

export async function writeRequestBody({
	request,
	path,
}: {
	request: Request;
	path: string;
}): Promise<void> {
	if (!request.body) throw new Error("Request body is missing");
	await pipeline(
		Readable.from(readWebStream(request.body)),
		createWriteStream(path),
	);
}

export function safeSourceExtension(filename: string | null): string {
	const name = basename(filename ?? "source");
	const match = name.match(/\.[a-zA-Z0-9]{1,8}$/);
	return match?.[0]?.toLowerCase() ?? ".media";
}

export function requireLocalNativeRequest(request: Request): void {
	const url = new URL(request.url);
	if (!isLoopbackHostname(url.hostname)) {
		throw new Error("Native media endpoints only accept loopback requests");
	}
	const origin = request.headers.get("origin");
	if (origin) {
		const originUrl = new URL(origin);
		if (
			!isLoopbackHostname(originUrl.hostname) ||
			originUrl.port !== url.port ||
			originUrl.protocol !== url.protocol
		) {
			throw new Error("Native media request origin is not allowed");
		}
	}
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
	);
}
