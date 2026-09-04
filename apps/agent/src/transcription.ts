import { createHash } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inspectProject, runCommand } from "./client";
import {
	loadHyprwhsprSettings,
	normalizeRemoteTranscription,
	transcribeWithHyprwhspr,
	type HyprwhsprSettings,
} from "./hyprwhspr-transcriber";

const TICKS_PER_SECOND = 120_000;
const TRANSCRIPT_SCHEMA_VERSION = 1;
const LOCAL_MODELS = [
	"tiny.en",
	"base.en",
	"small.en",
	"medium.en",
	"large-v3",
] as const;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/u;

export type TranscriptionBackend = "local" | "hyprwhspr";
export type TranscriptionDetail = "text" | "segments" | "words";

export interface TranscriptWord {
	text: string;
	start: number;
	end: number;
}

export interface TranscriptSegment {
	text: string;
	start: number;
	end: number;
}

export interface SourceTranscript {
	schemaVersion: number;
	createdAt: string;
	timeBasis: "source-media-seconds";
	projectId: string;
	sourceProjectRevision: string;
	media: MediaSnapshot;
	backend: {
		kind: TranscriptionBackend;
		engine: string;
		model: string;
		language?: string;
		provider?: string;
	};
	durationSeconds: number;
	text: string;
	words: TranscriptWord[];
	segments: TranscriptSegment[];
}

export interface TimelineTranscriptWord extends TranscriptWord {
	mediaId: string;
	clipId: string;
	sourceStart: number;
	sourceEnd: number;
}

export interface TimelineTranscript {
	timeBasis: "project-timeline-seconds";
	projectRevision: string;
	mediaId: string;
	clipCount: number;
	text: string;
	words: TimelineTranscriptWord[];
	segments: TranscriptSegment[];
}

export interface TranscribeMediaResult {
	cacheHit: boolean;
	selectedAutomatically: boolean;
	transcriptPath: string;
	transcript: SourceTranscript;
	timeline: TimelineTranscript;
	note: string;
}

export function presentTranscriptionResult({
	result,
	detail = "segments",
}: {
	result: TranscribeMediaResult;
	detail?: TranscriptionDetail;
}): Record<string, unknown> {
	const source = {
		timeBasis: result.transcript.timeBasis,
		createdAt: result.transcript.createdAt,
		media: result.transcript.media,
		backend: result.transcript.backend,
		durationSeconds: result.transcript.durationSeconds,
		wordCount: result.transcript.words.length,
		segmentCount: result.transcript.segments.length,
	};
	const timeline = {
		timeBasis: result.timeline.timeBasis,
		projectRevision: result.timeline.projectRevision,
		mediaId: result.timeline.mediaId,
		clipCount: result.timeline.clipCount,
		wordCount: result.timeline.words.length,
		segmentCount: result.timeline.segments.length,
	};
	return {
		cacheHit: result.cacheHit,
		selectedAutomatically: result.selectedAutomatically,
		transcriptPath: result.transcriptPath,
		detail,
		source:
			detail === "words"
				? {
						...source,
						text: result.transcript.text,
						words: result.transcript.words,
					}
				: source,
		timeline:
			detail === "words"
				? {
						...timeline,
						text: result.timeline.text,
						segments: result.timeline.segments,
						words: result.timeline.words,
					}
				: detail === "text"
					? { ...timeline, text: result.timeline.text }
					: { ...timeline, segments: result.timeline.segments },
		note: result.note,
	};
}

interface MediaSnapshot {
	id: string;
	name: string;
	type: string;
	sizeBytes: number;
	durationSeconds?: number;
	hasAudio?: boolean;
	codec?: string;
	proxyState?: string;
}

interface ProjectSnapshot {
	revision: string;
	project: { id: string; name: string };
	activeScene: { tracks: unknown };
	media: MediaSnapshot[];
}

type ResolvedBackend =
	| {
			kind: "local";
			engine: "hyperframes/whisper.cpp";
			model: (typeof LOCAL_MODELS)[number];
			language?: string;
	  }
	| {
			kind: "hyprwhspr";
			engine: "hyprwhspr-compatible-rest";
			model: string;
			language?: string;
			provider: string;
			settings: HyprwhsprSettings;
	  };

interface StagedArtifact {
	artifactId: string;
	path: string;
	usedProxy: boolean;
}

export async function transcribeProjectMedia({
	projectId,
	mediaId,
	backend = "local",
	model,
	language = "en",
	force = false,
}: {
	projectId: string;
	mediaId?: string;
	backend?: TranscriptionBackend;
	model?: string;
	language?: string;
	force?: boolean;
}): Promise<TranscribeMediaResult> {
	const snapshot = parseProjectSnapshot(await inspectProject(projectId));
	const selectedMediaId = mediaId ?? selectPrimaryAudibleMedia(snapshot);
	const media = snapshot.media.find(
		(candidate) => candidate.id === selectedMediaId,
	);
	if (!media) throw new Error(`Media asset ${selectedMediaId} was not found`);
	if (media.type === "video" && media.hasAudio === false) {
		throw new Error(`Media asset ${media.name} has no audio stream`);
	}
	const resolvedBackend = await resolveBackend({ backend, model, language });
	const cacheKey = transcriptionCacheKey({ media, backend: resolvedBackend });
	const transcriptDirectory = join(
		agentDataRoot(),
		"projects",
		validateId(snapshot.project.id),
		"transcripts",
		validateId(media.id),
		cacheKey,
	);
	const transcriptPath = join(transcriptDirectory, "transcript.json");
	if (!force) {
		const cached = await readCachedTranscript(transcriptPath);
		if (cached) {
			return buildResult({
				cacheHit: true,
				selectedAutomatically: mediaId === undefined,
				transcriptPath,
				transcript: cached,
				snapshot,
			});
		}
	}

	await mkdir(transcriptDirectory, { recursive: true, mode: 0o700 });
	await chmod(transcriptDirectory, 0o700);
	const lockPath = join(transcriptDirectory, ".transcribing.lock");
	let lock: Awaited<ReturnType<typeof open>>;
	try {
		lock = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if (isErrorCode(error, "EEXIST")) {
			throw new Error(
				"A transcription for this media and backend is already running",
			);
		}
		throw error;
	}

	let staged: StagedArtifact | null = null;
	let workingDirectory: string | null = null;
	try {
		workingDirectory = await mkdtemp(join(transcriptDirectory, ".run-"));
		staged = readStagedArtifact(
			await runCommand({
				projectId: snapshot.project.id,
				kind: "stage_media",
				payload: { mediaId: media.id, preferProxy: true },
				timeoutMs: 10 * 60 * 1000,
			}),
		);
		const generated =
			resolvedBackend.kind === "local"
				? await transcribeWithHyperframes({
						mediaPath: staged.path,
						workingDirectory,
						model: resolvedBackend.model,
						language: resolvedBackend.language,
					})
				: await transcribeWithHyprwhspr({
						mediaPath: staged.path,
						durationSeconds: requireDuration(media),
						workingDirectory,
						settings: resolvedBackend.settings,
					});
		const words = normalizeWords(generated.words);
		const text = generated.text.trim() || joinTranscriptWords(words);
		const segments =
			generated.segments.length > 0
				? normalizeSegments(generated.segments)
				: buildTranscriptSegments(words);
		const transcript: SourceTranscript = {
			schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
			createdAt: new Date().toISOString(),
			timeBasis: "source-media-seconds",
			projectId: snapshot.project.id,
			sourceProjectRevision: snapshot.revision,
			media,
			backend: publicBackend(resolvedBackend),
			durationSeconds: generated.durationSeconds || requireDuration(media),
			text,
			words,
			segments,
		};
		await writeJsonAtomic({ path: transcriptPath, value: transcript });
		return buildResult({
			cacheHit: false,
			selectedAutomatically: mediaId === undefined,
			transcriptPath,
			transcript,
			snapshot,
		});
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
		if (workingDirectory) {
			await rm(workingDirectory, { recursive: true, force: true });
		}
		if (staged) {
			await removeOwnedStagedArtifact(staged).catch(() => undefined);
		}
	}
}

export function normalizeHyperframesTranscript({
	value,
}: {
	value: unknown;
}): TranscriptWord[] {
	if (!Array.isArray(value)) {
		throw new Error("HyperFrames transcript must contain a word array");
	}
	return normalizeWords(
		value.flatMap((item): TranscriptWord[] => {
			if (!isRecord(item)) return [];
			const text = typeof item.text === "string" ? item.text.trim() : "";
			const start = finiteNumber(item.start);
			const end = finiteNumber(item.end);
			return text && start !== null && end !== null && end >= start
				? [{ text, start, end }]
				: [];
		}),
	);
}

export function joinTranscriptWords(words: TranscriptWord[]): string {
	return words
		.map((word) => word.text.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+([,.;!?%])/gu, "$1")
		.replace(/([([{])\s+/gu, "$1")
		.trim();
}

export function buildTranscriptSegments(
	words: TranscriptWord[],
): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	let current: TranscriptWord[] = [];
	const flush = () => {
		if (current.length === 0) return;
		segments.push({
			start: current[0]!.start,
			end: current.at(-1)!.end,
			text: joinTranscriptWords(current),
		});
		current = [];
	};
	for (const word of words) {
		const previous = current.at(-1);
		if (
			previous &&
			(word.start - previous.end >= 1.2 ||
				current.length >= 45 ||
				word.end - current[0]!.start >= 20)
		) {
			flush();
		}
		current.push(word);
	}
	flush();
	return segments;
}

export function mapSourceWordsToTimeline({
	words,
	snapshot,
	mediaId,
}: {
	words: TranscriptWord[];
	snapshot: Pick<ProjectSnapshot, "revision" | "activeScene">;
	mediaId: string;
}): TimelineTranscript {
	const clips = audibleClips({ snapshot, mediaId });
	const mapped = clips.flatMap((clip): TimelineTranscriptWord[] => {
		const sourceStart = clip.trimStart / TICKS_PER_SECOND;
		const sourceEnd =
			sourceStart + (clip.duration / TICKS_PER_SECOND) * clip.rate;
		return words.flatMap((word): TimelineTranscriptWord[] => {
			const midpoint = (word.start + word.end) / 2;
			if (midpoint < sourceStart || midpoint >= sourceEnd) return [];
			return [
				{
					text: word.text,
					start:
						clip.startTime / TICKS_PER_SECOND +
						(Math.max(word.start, sourceStart) - sourceStart) / clip.rate,
					end:
						clip.startTime / TICKS_PER_SECOND +
						(Math.min(word.end, sourceEnd) - sourceStart) / clip.rate,
					mediaId,
					clipId: clip.id,
					sourceStart: word.start,
					sourceEnd: word.end,
				},
			];
		});
	});
	mapped.sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	return {
		timeBasis: "project-timeline-seconds",
		projectRevision: snapshot.revision,
		mediaId,
		clipCount: clips.length,
		text: joinTranscriptWords(mapped),
		words: mapped,
		segments: buildTranscriptSegments(mapped),
	};
}

export function transcriptionCacheKey({
	media,
	backend,
}: {
	media: MediaSnapshot;
	backend: Pick<ResolvedBackend, "kind" | "engine" | "model" | "language"> & {
		provider?: string;
	};
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				media: {
					id: media.id,
					name: media.name,
					sizeBytes: media.sizeBytes,
					durationSeconds: media.durationSeconds,
					codec: media.codec,
				},
				backend: {
					kind: backend.kind,
					engine: backend.engine,
					model: backend.model,
					language: backend.language,
					provider: backend.provider,
				},
			}),
		)
		.digest("hex")
		.slice(0, 24);
}

async function transcribeWithHyperframes({
	mediaPath,
	workingDirectory,
	model,
	language,
}: {
	mediaPath: string;
	workingDirectory: string;
	model: (typeof LOCAL_MODELS)[number];
	language?: string;
}): Promise<{
	text: string;
	words: TranscriptWord[];
	segments: TranscriptSegment[];
	durationSeconds: number;
}> {
	const binary = await resolveHyperframesBinary();
	const args = [
		binary,
		"transcribe",
		mediaPath,
		"--engine",
		"whisper",
		"--model",
		model,
		"--json",
		"--dir",
		workingDirectory,
	];
	if (language) args.push("--language", language);
	const process = Bun.spawn(args, {
		cwd: workingDirectory,
		env: { ...processEnv(), NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`Local Whisper transcription failed: ${(stderr || stdout).slice(-4000)}`,
		);
	}
	const transcriptPath = join(workingDirectory, "transcript.json");
	const words = normalizeHyperframesTranscript({
		value: JSON.parse(await readFile(transcriptPath, "utf8")),
	});
	const summary = parseLastJsonObject(stdout);
	const reportedDuration = finiteNumber(summary?.durationSeconds);
	return {
		text: joinTranscriptWords(words),
		words,
		segments: buildTranscriptSegments(words),
		durationSeconds: reportedDuration ?? words.at(-1)?.end ?? 0,
	};
}

async function resolveBackend({
	backend,
	model,
	language,
}: {
	backend: TranscriptionBackend;
	model?: string;
	language?: string;
}): Promise<ResolvedBackend> {
	const validatedLanguage = validateLanguage(language);
	if (backend === "local") {
		const selected = model ?? "small.en";
		if (!LOCAL_MODELS.some((candidate) => candidate === selected)) {
			throw new Error(`Local model must be one of: ${LOCAL_MODELS.join(", ")}`);
		}
		return {
			kind: "local",
			engine: "hyperframes/whisper.cpp",
			// The membership check above narrows the runtime value to this list.
			model: selected as (typeof LOCAL_MODELS)[number],
			language: validatedLanguage,
		};
	}
	const settings = await loadHyprwhsprSettings({
		model,
		language: validatedLanguage,
	});
	return {
		kind: "hyprwhspr",
		engine: "hyprwhspr-compatible-rest",
		model: settings.model,
		language: settings.language,
		provider: settings.provider,
		settings,
	};
}

async function resolveHyperframesBinary(): Promise<string> {
	const candidates = [
		process.env.OPENCUT_HYPERFRAMES_BIN,
		resolve(import.meta.dir, "../node_modules/.bin/hyperframes"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Continue through explicit and workspace-local installations.
		}
	}
	throw new Error(
		"HyperFrames is unavailable. Run bun install in the OpenCut workspace.",
	);
}

function buildResult({
	cacheHit,
	selectedAutomatically,
	transcriptPath,
	transcript,
	snapshot,
}: {
	cacheHit: boolean;
	selectedAutomatically: boolean;
	transcriptPath: string;
	transcript: SourceTranscript;
	snapshot: ProjectSnapshot;
}): TranscribeMediaResult {
	return {
		cacheHit,
		selectedAutomatically,
		transcriptPath,
		transcript,
		timeline: mapSourceWordsToTimeline({
			words: transcript.words,
			snapshot,
			mediaId: transcript.media.id,
		}),
		note: "ASR timestamps are suitable for script review and navigation. Use forced acoustic alignment before destructive speech cuts.",
	};
}

function publicBackend(backend: ResolvedBackend): SourceTranscript["backend"] {
	return backend.kind === "local"
		? {
				kind: backend.kind,
				engine: backend.engine,
				model: backend.model,
				language: backend.language,
			}
		: {
				kind: backend.kind,
				engine: backend.engine,
				model: backend.model,
				language: backend.language,
				provider: backend.provider,
			};
}

function selectPrimaryAudibleMedia(snapshot: ProjectSnapshot): string {
	const coverage = new Map<string, number>();
	for (const clip of audibleClips({ snapshot })) {
		coverage.set(
			clip.mediaId,
			(coverage.get(clip.mediaId) ?? 0) + clip.duration,
		);
	}
	const selected = [...coverage].sort(
		(left, right) => right[1] - left[1],
	)[0]?.[0];
	if (selected) return selected;
	const fallback = snapshot.media.find(
		(media) =>
			media.type === "audio" ||
			(media.type === "video" && media.hasAudio !== false),
	);
	if (!fallback)
		throw new Error("The project has no audible media to transcribe");
	return fallback.id;
}

function audibleClips({
	snapshot,
	mediaId,
}: {
	snapshot: Pick<ProjectSnapshot, "activeScene">;
	mediaId?: string;
}): Array<{
	id: string;
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	rate: number;
}> {
	return flattenTracks(snapshot.activeScene.tracks).flatMap((track) => {
		if (track.muted === true || !Array.isArray(track.elements)) return [];
		return track.elements.flatMap((element) => {
			if (!isRecord(element)) return [];
			if (!(element.type === "video" || element.type === "audio")) return [];
			if (typeof element.mediaId !== "string") return [];
			if (mediaId && element.mediaId !== mediaId) return [];
			if (element.type === "video" && element.isSourceAudioEnabled === false) {
				return [];
			}
			const params = isRecord(element.params) ? element.params : {};
			if (params.muted === true) return [];
			const id = typeof element.id === "string" ? element.id : "unknown-clip";
			const startTime = positiveOrZeroInteger(element.startTime);
			const duration = positiveInteger(element.duration);
			const trimStart = positiveOrZeroInteger(element.trimStart);
			if (startTime === null || duration === null || trimStart === null)
				return [];
			const retime = isRecord(element.retime) ? element.retime : {};
			const rate =
				typeof retime.rate === "number" &&
				Number.isFinite(retime.rate) &&
				retime.rate > 0
					? retime.rate
					: 1;
			return [
				{ id, mediaId: element.mediaId, startTime, duration, trimStart, rate },
			];
		});
	});
}

function flattenTracks(value: unknown): Array<Record<string, unknown>> {
	if (!isRecord(value)) return [];
	return Object.values(value).flatMap(
		(track): Array<Record<string, unknown>> => {
			if (Array.isArray(track)) return track.filter(isRecord);
			return isRecord(track) ? [track] : [];
		},
	);
}

function parseProjectSnapshot(value: unknown): ProjectSnapshot {
	if (
		!isRecord(value) ||
		typeof value.revision !== "string" ||
		!isRecord(value.project) ||
		typeof value.project.id !== "string" ||
		typeof value.project.name !== "string" ||
		!isRecord(value.activeScene) ||
		!("tracks" in value.activeScene) ||
		!Array.isArray(value.media)
	) {
		throw new Error("OpenCut returned an invalid project snapshot");
	}
	const media = value.media.flatMap((item): MediaSnapshot[] => {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			typeof item.name !== "string" ||
			typeof item.type !== "string" ||
			typeof item.sizeBytes !== "number"
		) {
			return [];
		}
		return [
			{
				id: item.id,
				name: item.name,
				type: item.type,
				sizeBytes: item.sizeBytes,
				durationSeconds: finiteNumber(item.durationSeconds) ?? undefined,
				hasAudio:
					typeof item.hasAudio === "boolean" ? item.hasAudio : undefined,
				codec: typeof item.codec === "string" ? item.codec : undefined,
				proxyState:
					typeof item.proxyState === "string" ? item.proxyState : undefined,
			},
		];
	});
	return {
		revision: value.revision,
		project: { id: value.project.id, name: value.project.name },
		activeScene: { tracks: value.activeScene.tracks },
		media,
	};
}

function readStagedArtifact(value: unknown): StagedArtifact {
	if (!isRecord(value) || value.success !== true || !isRecord(value.result)) {
		throw new Error("Media staging failed");
	}
	const result = value.result;
	if (
		typeof result.artifactId !== "string" ||
		typeof result.path !== "string"
	) {
		throw new Error("Media staging did not return an artifact path");
	}
	return {
		artifactId: result.artifactId,
		path: result.path,
		usedProxy: result.usedProxy === true,
	};
}

async function removeOwnedStagedArtifact(
	staged: StagedArtifact,
): Promise<void> {
	const directory = dirname(staged.path);
	if (basename(directory) !== staged.artifactId) return;
	await rm(directory, { recursive: true, force: true });
}

async function readCachedTranscript(
	path: string,
): Promise<SourceTranscript | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			!isRecord(value) ||
			value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION ||
			!Array.isArray(value.words) ||
			typeof value.text !== "string" ||
			!isRecord(value.media) ||
			typeof value.media.id !== "string"
		) {
			throw new Error("Cached transcript is invalid");
		}
		return value as unknown as SourceTranscript;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}

async function writeJsonAtomic({
	path,
	value,
}: {
	path: string;
	value: unknown;
}): Promise<void> {
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, path);
}

function normalizeWords(words: TranscriptWord[]): TranscriptWord[] {
	return words
		.filter(
			(word) =>
				word.text.trim() &&
				Number.isFinite(word.start) &&
				Number.isFinite(word.end) &&
				word.start >= 0 &&
				word.end >= word.start,
		)
		.map((word) => ({ ...word, text: word.text.trim() }))
		.sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
	return segments
		.filter(
			(segment) =>
				segment.text.trim() &&
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.start >= 0 &&
				segment.end >= segment.start,
		)
		.map((segment) => ({ ...segment, text: segment.text.trim() }))
		.sort((left, right) => left.start - right.start || left.end - right.end);
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
	for (const line of output.trim().split("\n").reverse()) {
		try {
			const value: unknown = JSON.parse(line);
			if (isRecord(value)) return value;
		} catch {
			// Continue past progress output to the final JSON summary.
		}
	}
	return null;
}

function requireDuration(media: MediaSnapshot): number {
	if (
		typeof media.durationSeconds !== "number" ||
		!Number.isFinite(media.durationSeconds) ||
		media.durationSeconds <= 0
	) {
		throw new Error(`Media duration is unavailable for ${media.name}`);
	}
	return media.durationSeconds;
}

function agentDataRoot(): string {
	return (
		process.env.OPENCUT_AGENT_DATA_DIR ??
		join(
			process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
			"opencut-agent",
		)
	);
}

function validateId(value: string): string {
	if (!SAFE_ID.test(value)) throw new Error("Invalid OpenCut identifier");
	return value;
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

function processEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env));
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}

function positiveOrZeroInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Re-exported for focused parser tests without exposing credential-bearing settings.
export { normalizeRemoteTranscription };
