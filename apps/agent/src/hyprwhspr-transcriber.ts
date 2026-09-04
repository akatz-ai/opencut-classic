import { readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface HyprwhsprSettings {
	provider: string;
	model: string;
	language?: string;
	endpoint: string;
	apiKey: string;
	timeoutSeconds: number;
	chunkSeconds: number;
	rateLimitRpm: number;
	prompt?: string;
	temperature?: number;
	customHeaders: Record<string, string>;
}

export interface RemoteTranscriptWord {
	text: string;
	start: number;
	end: number;
}

export interface RemoteTranscriptSegment {
	text: string;
	start: number;
	end: number;
}

export interface RemoteTranscript {
	text: string;
	words: RemoteTranscriptWord[];
	segments: RemoteTranscriptSegment[];
	durationSeconds: number;
}

type JsonRecord = Record<string, unknown>;

export async function loadHyprwhsprSettings({
	model,
	language,
}: {
	model?: string;
	language?: string;
}): Promise<HyprwhsprSettings> {
	const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const dataHome =
		process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	const configPath =
		process.env.HYPRWHSPR_CONFIG_PATH ??
		join(configHome, "hyprwhspr", "config.json");
	const credentialsPath =
		process.env.HYPRWHSPR_CREDENTIALS_PATH ??
		join(dataHome, "hyprwhspr", "credentials");
	const config = readRecord(
		await readFile(configPath, "utf8"),
		"Hyprwhspr config",
	);
	if (config.transcription_backend !== "rest-api") {
		throw new Error(
			"Hyprwhspr must use its rest-api backend before remote transcription is available",
		);
	}
	const endpoint = requiredString(
		config.rest_endpoint_url,
		"rest_endpoint_url",
	);
	validateEndpoint(endpoint);
	const provider = requiredString(
		config.rest_api_provider,
		"rest_api_provider",
	);
	const credentialsStat = await stat(credentialsPath);
	if ((credentialsStat.mode & 0o077) !== 0) {
		throw new Error("Hyprwhspr credentials must be owner-only (mode 0600)");
	}
	const credentials = readRecord(
		await readFile(credentialsPath, "utf8"),
		"Hyprwhspr credentials",
	);
	const apiKey = requiredString(
		credentials[provider],
		`credential for ${provider}`,
	);
	const restBody = optionalRecord(config.rest_body, "rest_body");
	const configuredModel = requiredString(restBody.model, "rest_body.model");
	const configuredLanguage = optionalString(config.language);
	const timeoutSeconds = boundedNumber({
		value: config.rest_timeout,
		fallback: 30,
		minimum: 1,
		maximum: 300,
	});
	const chunkSeconds = boundedNumber({
		value: config.rest_chunk_max_seconds,
		fallback: 480,
		minimum: 10,
		maximum: 480,
	});
	const rateLimitRpm = boundedNumber({
		value: config.rest_chunk_rate_limit_rpm,
		fallback: 20,
		minimum: 1,
		maximum: 600,
	});
	const customHeaders = stringRecord(
		optionalRecord(config.rest_headers, "rest_headers"),
	);
	for (const name of Object.keys(customHeaders)) {
		if (/^(?:authorization|content-type)$/iu.test(name)) {
			throw new Error(
				`Hyprwhspr ${name} must not be stored in rest_headers for OpenCut transcription`,
			);
		}
	}
	return {
		provider,
		model: validateModel(model ?? configuredModel),
		language: validateLanguage(language ?? configuredLanguage),
		endpoint,
		apiKey,
		timeoutSeconds,
		chunkSeconds,
		rateLimitRpm,
		prompt: optionalString(config.whisper_prompt),
		temperature:
			typeof restBody.temperature === "number"
				? restBody.temperature
				: undefined,
		customHeaders,
	};
}

export async function transcribeWithHyprwhspr({
	mediaPath,
	durationSeconds,
	workingDirectory,
	settings,
}: {
	mediaPath: string;
	durationSeconds: number;
	workingDirectory: string;
	settings: HyprwhsprSettings;
}): Promise<RemoteTranscript> {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		throw new Error("Media duration must be positive for remote transcription");
	}
	const words: RemoteTranscriptWord[] = [];
	const segments: RemoteTranscriptSegment[] = [];
	const textParts: string[] = [];
	const totalChunks = Math.ceil(durationSeconds / settings.chunkSeconds);
	const minimumIntervalMs = 60_000 / settings.rateLimitRpm;
	let lastRequestAt = 0;
	for (let index = 0; index < totalChunks; index++) {
		const offset = index * settings.chunkSeconds;
		const chunkDuration = Math.min(
			settings.chunkSeconds,
			durationSeconds - offset,
		);
		const chunkPath = join(
			workingDirectory,
			`audio-${String(index + 1).padStart(3, "0")}.flac`,
		);
		await extractSpeechAudio({
			mediaPath,
			outputPath: chunkPath,
			offset,
			duration: chunkDuration,
		});
		try {
			const delay = minimumIntervalMs - (Date.now() - lastRequestAt);
			if (delay > 0) await Bun.sleep(delay);
			lastRequestAt = Date.now();
			const response = await transcribeRemoteChunk({
				path: chunkPath,
				settings,
			});
			if (response.text.trim()) textParts.push(response.text.trim());
			words.push(
				...response.words.map((word) => ({
					...word,
					start: word.start + offset,
					end: word.end + offset,
				})),
			);
			segments.push(
				...response.segments.map((segment) => ({
					...segment,
					start: segment.start + offset,
					end: segment.end + offset,
				})),
			);
		} finally {
			await rm(chunkPath, { force: true });
		}
	}
	return {
		text: textParts.join("\n\n"),
		words,
		segments,
		durationSeconds,
	};
}

export function normalizeRemoteTranscription({
	value,
}: {
	value: unknown;
}): Omit<RemoteTranscript, "durationSeconds"> {
	if (!isRecord(value))
		throw new Error("Remote transcriber returned invalid JSON");
	const text = optionalString(value.text) ?? "";
	const words = Array.isArray(value.words)
		? value.words.flatMap((word): RemoteTranscriptWord[] => {
				if (!isRecord(word)) return [];
				const wordText = optionalString(word.word) ?? optionalString(word.text);
				const start = finiteNumber(word.start);
				const end = finiteNumber(word.end);
				return wordText && start !== null && end !== null && end >= start
					? [{ text: wordText.trim(), start, end }]
					: [];
			})
		: [];
	const segments = Array.isArray(value.segments)
		? value.segments.flatMap((segment): RemoteTranscriptSegment[] => {
				if (!isRecord(segment)) return [];
				const segmentText = optionalString(segment.text);
				const start = finiteNumber(segment.start);
				const end = finiteNumber(segment.end);
				return segmentText && start !== null && end !== null && end >= start
					? [{ text: segmentText.trim(), start, end }]
					: [];
			})
		: [];
	if (!text && words.length === 0 && segments.length === 0) {
		throw new Error("Remote transcriber returned no spoken text");
	}
	return { text, words, segments };
}

async function transcribeRemoteChunk({
	path,
	settings,
}: {
	path: string;
	settings: HyprwhsprSettings;
}): Promise<Omit<RemoteTranscript, "durationSeconds">> {
	const body = new FormData();
	body.set("file", Bun.file(path), basename(path));
	body.set("model", settings.model);
	body.set("response_format", "verbose_json");
	body.append("timestamp_granularities[]", "word");
	body.append("timestamp_granularities[]", "segment");
	body.set("temperature", String(settings.temperature ?? 0));
	if (settings.language) body.set("language", settings.language);
	if (settings.prompt) body.set("prompt", settings.prompt);
	const response = await fetch(settings.endpoint, {
		method: "POST",
		headers: {
			...settings.customHeaders,
			Authorization: `Bearer ${settings.apiKey}`,
		},
		body,
		signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`Remote transcription failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(responseText);
	} catch {
		throw new Error("Remote transcriber returned non-JSON output");
	}
	return normalizeRemoteTranscription({ value });
}

async function extractSpeechAudio({
	mediaPath,
	outputPath,
	offset,
	duration,
}: {
	mediaPath: string;
	outputPath: string;
	offset: number;
	duration: number;
}): Promise<void> {
	const process = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			String(offset),
			"-t",
			String(duration),
			"-i",
			mediaPath,
			"-map",
			"0:a:0",
			"-vn",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"flac",
			outputPath,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const stderr = await new Response(process.stderr).text();
	if ((await process.exited) !== 0) {
		throw new Error(`FFmpeg audio extraction failed: ${stderr.slice(-2000)}`);
	}
}

function validateEndpoint(endpoint: string): void {
	const url = new URL(endpoint);
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
		throw new Error(
			"Hyprwhspr transcription endpoint must use HTTPS or loopback HTTP",
		);
	}
}

function validateModel(model: string): string {
	if (!/^[a-zA-Z0-9._/-]{1,120}$/u.test(model)) {
		throw new Error("Transcription model contains unsupported characters");
	}
	return model;
}

function validateLanguage(language: string | undefined): string | undefined {
	if (language === undefined || language === "auto") return undefined;
	if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language)) {
		throw new Error(
			"Language must be an ISO language code such as en or pt-BR",
		);
	}
	return language;
}

function readRecord(serialized: string, label: string): JsonRecord {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
	if (!isRecord(value)) throw new Error(`${label} must contain an object`);
	return value;
}

function optionalRecord(value: unknown, label: string): JsonRecord {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new Error(`${label} must contain an object`);
	return value;
}

function stringRecord(value: JsonRecord): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) =>
			typeof item === "string" ? [[key, item]] : [],
		),
	);
}

function requiredString(value: unknown, label: string): string {
	const parsed = optionalString(value);
	if (!parsed) throw new Error(`${label} is required`);
	return parsed;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedNumber({
	value,
	fallback,
	minimum,
	maximum,
}: {
	value: unknown;
	fallback: number;
	minimum: number;
	maximum: number;
}): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= minimum &&
		value <= maximum
		? value
		: fallback;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
