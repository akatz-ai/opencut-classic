import { readFile } from "node:fs/promises";

const TICKS_PER_SECOND = 120_000;

export interface TranscriptWord {
	text: string;
	start: number;
	end: number;
}

export interface SilenceRange {
	start: number;
	end: number;
	duration: number;
}

export interface SpeechCutPlan {
	projectId: string;
	revision: string;
	mediaId: string;
	createdAt: string;
	settings: {
		silenceThresholdDb: number;
		minimumSilenceSeconds: number;
		preservedSilenceSeconds: number;
	};
	ranges: Array<{
		startSeconds: number;
		endSeconds: number;
		sourceStartSeconds: number;
		sourceEndSeconds: number;
		reason: string;
		context: string;
	}>;
	totalRemovedSeconds: number;
}

interface ProjectSnapshot {
	revision: string;
	project: { id: string; fps: number };
	activeScene: {
		tracks: {
			main: {
				elements: Array<{
					type: string;
					mediaId?: string;
					startTime: number;
					duration: number;
					trimStart: number;
					retime?: { rate: number };
				}>;
			};
		};
	};
}

export async function readTranscriptWords(
	path: string,
): Promise<TranscriptWord[]> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	const candidates = Array.isArray(value)
		? value
		: typeof value === "object" &&
			  value !== null &&
			  "transcription" in value &&
			  Array.isArray(value.transcription)
			? value.transcription
			: null;
	if (!candidates) throw new Error("Transcript must contain a word array");
	return candidates.flatMap((word): TranscriptWord[] => {
		if (
			typeof word !== "object" ||
			word === null ||
			!("text" in word) ||
			typeof word.text !== "string" ||
			!readWordTiming(word)
		) {
			return [];
		}
		const timing = readWordTiming(word);
		if (!timing || word.text.trim() === "") return [];
		return [{ text: word.text, start: timing.start, end: timing.end }];
	});
}

export async function readSilenceRanges(path: string): Promise<SilenceRange[]> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!Array.isArray(value)) throw new Error("Silence plan must be an array");
	return value.flatMap((range): SilenceRange[] => {
		if (
			typeof range !== "object" ||
			range === null ||
			!("start" in range) ||
			typeof range.start !== "number" ||
			!("end" in range) ||
			typeof range.end !== "number" ||
			range.end <= range.start
		) {
			throw new Error("Every silence range must have numeric start < end");
		}
		return [
			{ start: range.start, end: range.end, duration: range.end - range.start },
		];
	});
}

function readWordTiming(
	word: Record<string, unknown>,
): { start: number; end: number } | null {
	if (typeof word.start === "number" && typeof word.end === "number") {
		return { start: word.start, end: word.end };
	}
	const offsets = word.offsets;
	if (
		typeof offsets === "object" &&
		offsets !== null &&
		"from" in offsets &&
		typeof offsets.from === "number" &&
		"to" in offsets &&
		typeof offsets.to === "number"
	) {
		return { start: offsets.from / 1000, end: offsets.to / 1000 };
	}
	return null;
}

export async function detectSilences({
	mediaPath,
	thresholdDb,
	minimumSeconds,
}: {
	mediaPath: string;
	thresholdDb: number;
	minimumSeconds: number;
}): Promise<SilenceRange[]> {
	const process = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-i",
			mediaPath,
			"-af",
			`silencedetect=noise=${thresholdDb}dB:d=${minimumSeconds}`,
			"-f",
			"null",
			"-",
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const stderr = await new Response(process.stderr).text();
	const exitCode = await process.exited;
	if (exitCode !== 0)
		throw new Error(`FFmpeg silence detection failed: ${stderr}`);
	const starts: number[] = [];
	const ranges: SilenceRange[] = [];
	for (const line of stderr.split("\n")) {
		const start = line.match(/silence_start:\s*([0-9.]+)/)?.[1];
		if (start) starts.push(Number(start));
		const end = line.match(
			/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/,
		);
		if (end && starts.length > 0) {
			ranges.push({
				start: starts.shift()!,
				end: Number(end[1]),
				duration: Number(end[2]),
			});
		}
	}
	return ranges;
}

export function buildSpeechCutPlan({
	snapshot,
	mediaId,
	words,
	fillerWords = words,
	silences,
	thresholdDb = -30,
	minimumSilenceSeconds = 0.6,
	preservedSilenceSeconds = 0.24,
}: {
	snapshot: ProjectSnapshot;
	mediaId: string;
	words: TranscriptWord[];
	fillerWords?: TranscriptWord[];
	silences: SilenceRange[];
	thresholdDb?: number;
	minimumSilenceSeconds?: number;
	preservedSilenceSeconds?: number;
}): SpeechCutPlan {
	const lastWordEnd = words.reduce(
		(latest, word) => Math.max(latest, word.end),
		0,
	);
	const sourceCandidates = [
		...silences.flatMap((silence) => {
			const trim = preservedSilenceSeconds / 2;
			const isTrailingSilence = silence.start >= lastWordEnd;
			return silence.duration - preservedSilenceSeconds >= 0.25
				? [
						{
							start: silence.start + trim,
							end: isTrailingSilence
								? Number.POSITIVE_INFINITY
								: silence.end - trim,
							reason: `dead air (${silence.duration.toFixed(2)}s)`,
						},
					]
				: [];
		}),
		...fillerWords.flatMap((word) =>
			/^(?:um+|uh+|erm+|hmm+)[,.!?]*$/iu.test(word.text.trim())
				? [
						{
							start: Math.max(0, word.start),
							end: word.end,
							reason: `filler: ${word.text}`,
						},
					]
				: [],
		),
	];

	const clips = snapshot.activeScene.tracks.main.elements.filter(
		(element) => element.type === "video" && element.mediaId === mediaId,
	);
	const mappedRanges = sourceCandidates.flatMap((candidate) =>
		clips.flatMap((clip) => {
			const rate = clip.retime?.rate ?? 1;
			const sourceStart = clip.trimStart / TICKS_PER_SECOND;
			const sourceEnd = sourceStart + (clip.duration / TICKS_PER_SECOND) * rate;
			const intersectionStart = Math.max(candidate.start, sourceStart);
			const intersectionEnd = Math.min(candidate.end, sourceEnd);
			if (intersectionEnd <= intersectionStart) return [];
			const rawTimelineStart =
				clip.startTime / TICKS_PER_SECOND +
				(intersectionStart - sourceStart) / rate;
			const rawTimelineEnd =
				clip.startTime / TICKS_PER_SECOND +
				(intersectionEnd - sourceStart) / rate;
			const fps = snapshot.project.fps;
			const timelineStart = Math.max(
				clip.startTime / TICKS_PER_SECOND,
				Math.floor(rawTimelineStart * fps + 1e-4) / fps,
			);
			const timelineEnd = Math.min(
				(clip.startTime + clip.duration) / TICKS_PER_SECOND,
				Math.ceil(rawTimelineEnd * fps - 1e-4) / fps,
			);
			const snappedSourceStart =
				sourceStart +
				(timelineStart - clip.startTime / TICKS_PER_SECOND) * rate;
			const snappedSourceEnd =
				sourceStart + (timelineEnd - clip.startTime / TICKS_PER_SECOND) * rate;
			return [
				{
					startSeconds: round(timelineStart),
					endSeconds: round(timelineEnd),
					sourceStartSeconds: round(snappedSourceStart),
					sourceEndSeconds: round(snappedSourceEnd),
					reason: candidate.reason,
					context: contextAt({
						words,
						time: (intersectionStart + intersectionEnd) / 2,
					}),
				},
			];
		}),
	);
	const ranges = normalizeMappedRanges(mappedRanges);
	return {
		projectId: snapshot.project.id,
		revision: snapshot.revision,
		mediaId,
		createdAt: new Date().toISOString(),
		settings: {
			silenceThresholdDb: thresholdDb,
			minimumSilenceSeconds,
			preservedSilenceSeconds,
		},
		ranges,
		totalRemovedSeconds: round(
			ranges.reduce(
				(total, range) => total + range.endSeconds - range.startSeconds,
				0,
			),
		),
	};
}

function normalizeMappedRanges(
	ranges: SpeechCutPlan["ranges"],
): SpeechCutPlan["ranges"] {
	const sorted = [...ranges].sort(
		(left, right) => left.startSeconds - right.startSeconds,
	);
	const normalized: SpeechCutPlan["ranges"] = [];
	for (const range of sorted) {
		const previous = normalized.at(-1);
		if (previous && range.startSeconds <= previous.endSeconds + 0.18) {
			previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds);
			previous.sourceEndSeconds = Math.max(
				previous.sourceEndSeconds,
				range.sourceEndSeconds,
			);
			if (!previous.reason.includes(range.reason)) {
				previous.reason = `${previous.reason}; ${range.reason}`;
			}
			continue;
		}
		normalized.push({ ...range });
	}
	return normalized;
}

function contextAt({
	words,
	time,
}: {
	words: TranscriptWord[];
	time: number;
}): string {
	const closest = words.reduce(
		(best, word, index) => {
			const distance = Math.min(
				Math.abs(word.start - time),
				Math.abs(word.end - time),
			);
			return distance < best.distance ? { index, distance } : best;
		},
		{ index: 0, distance: Number.POSITIVE_INFINITY },
	).index;
	return words
		.slice(Math.max(0, closest - 6), closest + 7)
		.map((word) => word.text)
		.join(" ");
}

function round(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
