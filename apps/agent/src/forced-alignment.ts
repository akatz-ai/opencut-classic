import { readFile } from "node:fs/promises";

const FILLER_PATTERN = /^(?:um+|uh+|erm+|hmm+)[,.!?]*$/iu;

export interface AlignedWord {
	word: string;
	start: number | null;
	end: number | null;
	score: number | null;
}

export interface AlignmentPass {
	path: string;
	words: AlignedWord[];
}

export interface PcmAudio {
	sampleRate: number;
	samples: Float32Array;
}

export interface FillerBoundaryEvidence {
	ordinal: number;
	text: string;
	alignedStart: number;
	alignedEnd: number;
	speechStart: number;
	speechEnd: number;
	start: number;
	end: number;
	previousWord: string;
	nextWord: string;
	alignmentPasses: number;
	alignmentScore: number;
	startSpreadSeconds: number;
	endSpreadSeconds: number;
	snappedStart: number;
	snappedEnd: number;
	leftBoundaryDb: number;
	rightBoundaryDb: number;
	localNoiseDb: number;
	localSpeechDb: number;
	accepted: boolean;
	rejectionReason?: string;
}

interface AlignmentCandidate {
	passIndex: number;
	wordIndex: number;
	word: AlignedWord & { start: number; end: number; score: number };
	previous: AlignedWord | null;
	next: AlignedWord | null;
}

export async function readAlignmentPass(path: string): Promise<AlignmentPass> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (typeof value !== "object" || value === null || !("words" in value)) {
		throw new Error(`${path} is not an aligned transcript`);
	}
	const candidates = value.words;
	if (!Array.isArray(candidates)) {
		throw new Error(`${path} must contain a words array`);
	}
	return {
		path,
		words: candidates.flatMap((entry): AlignedWord[] => {
			if (
				typeof entry !== "object" ||
				entry === null ||
				!("word" in entry) ||
				typeof entry.word !== "string"
			) {
				return [];
			}
			return [
				{
					word: entry.word,
					start: finiteNumber("start" in entry ? entry.start : null),
					end: finiteNumber("end" in entry ? entry.end : null),
					score: finiteNumber("score" in entry ? entry.score : null),
				},
			];
		}),
	};
}

export async function readPcm16Wav(path: string): Promise<PcmAudio> {
	const bytes = await readFile(path);
	if (
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("Alignment audio must be a RIFF/WAVE file");
	}
	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let bitsPerSample = 0;
	let format = 0;
	let data: Buffer | null = null;
	while (offset + 8 <= bytes.length) {
		const id = bytes.toString("ascii", offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (start + size > bytes.length) break;
		if (id === "fmt ") {
			format = bytes.readUInt16LE(start);
			channels = bytes.readUInt16LE(start + 2);
			sampleRate = bytes.readUInt32LE(start + 4);
			bitsPerSample = bytes.readUInt16LE(start + 14);
		} else if (id === "data") {
			data = bytes.subarray(start, start + size);
		}
		offset = start + size + (size % 2);
	}
	if (
		format !== 1 ||
		channels !== 1 ||
		bitsPerSample !== 16 ||
		!sampleRate ||
		!data
	) {
		throw new Error("Alignment audio must be mono 16-bit PCM WAV");
	}
	const samples = new Float32Array(data.length / 2);
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = data.readInt16LE(index * 2) / 32768;
	}
	return { sampleRate, samples };
}

export function analyzeFillerBoundaries({
	passes,
	audio,
	fps,
	sourceOriginSeconds,
	endToleranceSeconds = 0.08,
	minimumAlignmentScore = 0.25,
}: {
	passes: AlignmentPass[];
	audio: PcmAudio;
	fps: number;
	sourceOriginSeconds: number;
	endToleranceSeconds?: number;
	minimumAlignmentScore?: number;
}): FillerBoundaryEvidence[] {
	if (passes.length < 2)
		throw new Error("At least two alignment passes are required");
	const byPass = passes.map((pass, passIndex) =>
		pass.words.flatMap((word, wordIndex): Array<AlignmentCandidate | null> => {
			if (!isFiller(word.word)) return [];
			if (word.start === null || word.end === null) return [null];
			const score = word.score ?? 0;
			if (word.end <= word.start) return [null];
			return [
				{
					passIndex,
					wordIndex,
					word: { ...word, start: word.start, end: word.end, score },
					previous: nearestTimedWord(pass.words, wordIndex, -1),
					next: nearestTimedWord(pass.words, wordIndex, 1),
				},
			];
		}),
	);
	const fillerCount = Math.max(...byPass.map((words) => words.length));
	const evidence: FillerBoundaryEvidence[] = [];
	for (let ordinal = 0; ordinal < fillerCount; ordinal += 1) {
		const candidates = byPass.flatMap((words) => {
			const candidate = words[ordinal];
			return candidate ? [candidate] : [];
		});
		const endCluster = bestEndCluster(candidates, endToleranceSeconds);
		const eligible = endCluster.filter(
			(candidate) =>
				candidate.word.score >= minimumAlignmentScore &&
				candidate.word.end - candidate.word.start >= 0.06 &&
				candidate.word.end - candidate.word.start <= 1.5,
		);
		const selected = [...eligible].sort(
			(left, right) =>
				left.word.start - right.word.start ||
				right.word.score - left.word.score,
		)[0];
		const fallback = candidates[0];
		if (!selected || endCluster.length < 2) {
			const alignedStart = fallback?.word.start ?? 0;
			const alignedEnd = fallback?.word.end ?? alignedStart;
			evidence.push({
				ordinal: ordinal + 1,
				text: fallback?.word.word ?? "unknown filler",
				alignedStart,
				alignedEnd,
				speechStart: alignedStart,
				speechEnd: alignedEnd,
				start: alignedStart,
				end: alignedEnd,
				previousWord: fallback?.previous?.word ?? "",
				nextWord: fallback?.next?.word ?? "",
				alignmentPasses: endCluster.length,
				alignmentScore: fallback?.word.score ?? 0,
				startSpreadSeconds: spread(
					candidates.map((candidate) => candidate.word.start),
				),
				endSpreadSeconds: spread(
					candidates.map((candidate) => candidate.word.end),
				),
				snappedStart: alignedStart,
				snappedEnd: alignedEnd,
				leftBoundaryDb: 0,
				rightBoundaryDb: 0,
				localNoiseDb: 0,
				localSpeechDb: 0,
				accepted: false,
				rejectionReason:
					endCluster.length < 2
						? "alignment passes did not agree on the filler end"
						: "alignment confidence was too low",
			});
			continue;
		}

		const alignedStart = Math.min(
			...eligible.map((candidate) => candidate.word.start),
		);
		const alignedEnd = Math.max(
			...eligible.map((candidate) => candidate.word.end),
		);
		const previousEnd = selected.previous?.end;
		const nextStart = selected.next?.start;
		const acoustic = findAcousticCut({
			audio,
			alignedStart,
			alignedEnd,
			fps,
			sourceOriginSeconds,
		});
		const rejectionReason = rejectBoundary({
			alignedStart,
			alignedEnd,
			acoustic,
			previousEnd,
			nextStart,
		});
		evidence.push({
			ordinal: ordinal + 1,
			text: selected.word.word,
			alignedStart: round(alignedStart),
			alignedEnd: round(alignedEnd),
			speechStart: round(acoustic.speechStart),
			speechEnd: round(acoustic.speechEnd),
			start: round(acoustic.snappedStart),
			end: round(acoustic.snappedEnd),
			previousWord: selected.previous?.word ?? "",
			nextWord: selected.next?.word ?? "",
			alignmentPasses: endCluster.length,
			alignmentScore: round(
				Math.max(...eligible.map((candidate) => candidate.word.score)),
			),
			startSpreadSeconds: round(
				spread(eligible.map((candidate) => candidate.word.start)),
			),
			endSpreadSeconds: round(
				spread(eligible.map((candidate) => candidate.word.end)),
			),
			snappedStart: round(acoustic.snappedStart),
			snappedEnd: round(acoustic.snappedEnd),
			leftBoundaryDb: round(acoustic.leftBoundaryDb),
			rightBoundaryDb: round(acoustic.rightBoundaryDb),
			localNoiseDb: round(acoustic.localNoiseDb),
			localSpeechDb: round(acoustic.localSpeechDb),
			accepted: rejectionReason === null,
			...(rejectionReason ? { rejectionReason } : {}),
		});
	}
	return evidence;
}

function bestEndCluster(
	candidates: AlignmentCandidate[],
	tolerance: number,
): AlignmentCandidate[] {
	let best: AlignmentCandidate[] = [];
	for (const anchor of candidates) {
		const cluster = candidates.filter(
			(candidate) =>
				Math.abs(candidate.word.end - anchor.word.end) <= tolerance,
		);
		const clusterScore = cluster.reduce(
			(total, candidate) => total + candidate.word.score,
			0,
		);
		const bestScore = best.reduce(
			(total, candidate) => total + candidate.word.score,
			0,
		);
		if (
			cluster.length > best.length ||
			(cluster.length === best.length && clusterScore > bestScore)
		) {
			best = cluster;
		}
	}
	return best;
}

function rejectBoundary({
	alignedStart,
	alignedEnd,
	acoustic,
	previousEnd,
	nextStart,
}: {
	alignedStart: number;
	alignedEnd: number;
	acoustic: AcousticCut;
	previousEnd: number | null | undefined;
	nextStart: number | null | undefined;
}): string | null {
	if (acoustic.rejectionReason) return acoustic.rejectionReason;
	if (
		previousEnd === null ||
		previousEnd === undefined ||
		nextStart === null ||
		nextStart === undefined
	) {
		return "neighboring aligned words were unavailable";
	}
	if (acoustic.snappedStart < previousEnd - 0.015) {
		return "frame-snapped start could overlap the previous word";
	}
	if (acoustic.snappedEnd > nextStart + 0.015) {
		return "frame-snapped end could overlap the next word";
	}
	if (acoustic.speechStart > alignedEnd || acoustic.speechEnd < alignedStart) {
		return "acoustic speech island did not overlap the aligned filler";
	}
	if (acoustic.snappedEnd - acoustic.snappedStart > 1.75) {
		return "acoustic filler region was implausibly long";
	}
	return null;
}

interface EnergyFrame {
	start: number;
	end: number;
	db: number;
	active: boolean;
}

interface SpeechRun {
	start: number;
	end: number;
}

interface AcousticCut {
	speechStart: number;
	speechEnd: number;
	snappedStart: number;
	snappedEnd: number;
	leftBoundaryDb: number;
	rightBoundaryDb: number;
	localNoiseDb: number;
	localSpeechDb: number;
	rejectionReason?: string;
}

function findAcousticCut({
	audio,
	alignedStart,
	alignedEnd,
	fps,
	sourceOriginSeconds,
}: {
	audio: PcmAudio;
	alignedStart: number;
	alignedEnd: number;
	fps: number;
	sourceOriginSeconds: number;
}): AcousticCut {
	const searchStart = Math.max(0, alignedStart - 0.75);
	const searchEnd = Math.min(
		audio.samples.length / audio.sampleRate,
		alignedEnd + 0.75,
	);
	const rawLevels = energyFrames(audio, searchStart, searchEnd, 0.01);
	const localNoiseDb = percentile(
		rawLevels.map((frame) => frame.db),
		0.2,
	);
	const localSpeechDb = percentile(
		rawLevels.map((frame) => frame.db),
		0.8,
	);
	const empty = (reason: string): AcousticCut => ({
		speechStart: alignedStart,
		speechEnd: alignedEnd,
		snappedStart: alignedStart,
		snappedEnd: alignedEnd,
		leftBoundaryDb: rmsDb(audio, alignedStart - 0.005, alignedStart + 0.005),
		rightBoundaryDb: rmsDb(audio, alignedEnd - 0.005, alignedEnd + 0.005),
		localNoiseDb,
		localSpeechDb,
		rejectionReason: reason,
	});
	if (localSpeechDb - localNoiseDb < 5) {
		return empty("audio did not have enough local dynamic range");
	}
	const activeThresholdDb =
		localNoiseDb +
		Math.min(12, Math.max(5, (localSpeechDb - localNoiseDb) * 0.45));
	const frames = rawLevels.map((frame) => ({
		...frame,
		active: frame.db > activeThresholdDb,
	}));
	closeShortQuietGaps(frames, 2);
	const runs = speechRuns(frames, 0.04);
	const targetMidpoint = (alignedStart + alignedEnd) / 2;
	const targetIndex = runs
		.map((run, index) => ({
			index,
			overlap: overlapSeconds(run.start, run.end, alignedStart, alignedEnd),
			distance: Math.abs((run.start + run.end) / 2 - targetMidpoint),
		}))
		.filter((candidate) => candidate.overlap > 0 || candidate.distance <= 0.35)
		.sort(
			(left, right) =>
				right.overlap - left.overlap || left.distance - right.distance,
		)[0]?.index;
	if (targetIndex === undefined)
		return empty("no acoustic speech island matched the filler");
	const target = runs[targetIndex]!;
	const previous = runs[targetIndex - 1];
	const next = runs[targetIndex + 1];
	if (!previous || !next)
		return empty("filler did not have quiet boundaries on both sides");
	if (
		Math.abs(target.start - alignedStart) > 0.4 ||
		Math.abs(target.end - alignedEnd) > 0.4
	) {
		return empty("acoustic speech island disagreed with the forced alignment");
	}
	const snappedStart = frameInGap({
		gapStart: previous.end,
		gapEnd: target.start,
		target: previous.end + 0.04,
		fps,
		sourceOriginSeconds,
	});
	const snappedEnd = frameInGap({
		gapStart: target.end,
		gapEnd: next.start,
		target: next.start - 0.04,
		fps,
		sourceOriginSeconds,
	});
	if (
		snappedStart === null ||
		snappedEnd === null ||
		snappedEnd <= snappedStart
	) {
		return empty(
			"no video-frame boundary fit inside the surrounding quiet audio",
		);
	}
	const leftBoundaryDb = rmsDb(
		audio,
		snappedStart - 0.005,
		snappedStart + 0.005,
	);
	const rightBoundaryDb = rmsDb(audio, snappedEnd - 0.005, snappedEnd + 0.005);
	if (
		leftBoundaryDb > activeThresholdDb + 3 ||
		rightBoundaryDb > activeThresholdDb + 3
	) {
		return {
			...empty("frame boundary was not quiet after acoustic snapping"),
			speechStart: target.start,
			speechEnd: target.end,
			snappedStart,
			snappedEnd,
			leftBoundaryDb,
			rightBoundaryDb,
		};
	}
	return {
		speechStart: target.start,
		speechEnd: target.end,
		snappedStart,
		snappedEnd,
		leftBoundaryDb,
		rightBoundaryDb,
		localNoiseDb,
		localSpeechDb,
	};
}

function energyFrames(
	audio: PcmAudio,
	start: number,
	end: number,
	windowSeconds: number,
): EnergyFrame[] {
	const frames: EnergyFrame[] = [];
	for (let time = start; time + windowSeconds <= end; time += windowSeconds) {
		frames.push({
			start: time,
			end: time + windowSeconds,
			db: rmsDb(audio, time, time + windowSeconds),
			active: false,
		});
	}
	return frames;
}

function closeShortQuietGaps(
	frames: EnergyFrame[],
	maximumFrames: number,
): void {
	let index = 0;
	while (index < frames.length) {
		if (frames[index]?.active) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < frames.length && !frames[index]?.active) index += 1;
		const length = index - start;
		if (
			length <= maximumFrames &&
			frames[start - 1]?.active &&
			frames[index]?.active
		) {
			for (let fill = start; fill < index; fill += 1)
				frames[fill]!.active = true;
		}
	}
}

function speechRuns(
	frames: EnergyFrame[],
	minimumSeconds: number,
): SpeechRun[] {
	const runs: SpeechRun[] = [];
	let index = 0;
	while (index < frames.length) {
		if (!frames[index]?.active) {
			index += 1;
			continue;
		}
		const start = frames[index]!.start;
		while (index < frames.length && frames[index]?.active) index += 1;
		const end = frames[index - 1]!.end;
		if (end - start >= minimumSeconds) runs.push({ start, end });
	}
	return runs;
}

function frameInGap({
	gapStart,
	gapEnd,
	target,
	fps,
	sourceOriginSeconds,
}: {
	gapStart: number;
	gapEnd: number;
	target: number;
	fps: number;
	sourceOriginSeconds: number;
}): number | null {
	const firstFrame = Math.ceil((gapStart - sourceOriginSeconds) * fps - 1e-6);
	const lastFrame = Math.floor((gapEnd - sourceOriginSeconds) * fps + 1e-6);
	if (firstFrame > lastFrame) return null;
	const targetFrame = Math.round((target - sourceOriginSeconds) * fps);
	const frame = Math.min(lastFrame, Math.max(firstFrame, targetFrame));
	return sourceOriginSeconds + frame / fps;
}

function overlapSeconds(
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
): number {
	return Math.max(
		0,
		Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart),
	);
}

function nearestTimedWord(
	words: AlignedWord[],
	fromIndex: number,
	direction: -1 | 1,
): AlignedWord | null {
	for (
		let index = fromIndex + direction;
		index >= 0 && index < words.length;
		index += direction
	) {
		const word = words[index];
		if (typeof word?.start === "number" && typeof word.end === "number")
			return word;
	}
	return null;
}

function rmsDb(audio: PcmAudio, start: number, end: number): number {
	const first = Math.max(0, Math.floor(start * audio.sampleRate));
	const last = Math.min(
		audio.samples.length,
		Math.ceil(end * audio.sampleRate),
	);
	if (last <= first) return -120;
	let sumSquares = 0;
	for (let index = first; index < last; index += 1) {
		const sample = audio.samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return (
		20 * Math.log10(Math.max(1e-6, Math.sqrt(sumSquares / (last - first))))
	);
}

function percentile(values: number[], ratio: number): number {
	if (values.length === 0) return -120;
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ??
		-120
	);
}

function spread(values: number[]): number {
	if (values.length === 0) return 0;
	return Math.max(...values) - Math.min(...values);
}

function isFiller(text: string): boolean {
	return FILLER_PATTERN.test(text.trim());
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
