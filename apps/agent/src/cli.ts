#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import {
	commandStatus,
	inspectProject,
	inspectView,
	listProjects,
	runCommand,
} from "./client";
import {
	buildSpeechCutPlan,
	detectSilences,
	readSilenceRanges,
	readTranscriptWords,
} from "./speech-cuts";
import {
	analyzeFillerBoundaries,
	readAlignmentPass,
	readPcm16Wav,
} from "./forced-alignment";
import {
	presentTranscriptionResult,
	transcribeProjectMedia,
} from "./transcription";

const [command, ...args] = process.argv.slice(2);

try {
	let result: unknown;
	switch (command) {
		case "projects":
			result = await listProjects();
			break;
		case "inspect":
			result = await inspectView(
				requiredOption(args, "--project"),
				Object.fromEntries([
					["detail", optionalOption(args, "--detail") ?? "overview"],
					...["sessionId", "clipId", "offset", "limit", "start", "end"].flatMap(
						(key) => {
							const value = optionalOption(
								args,
								key === "sessionId"
									? "--session"
									: key === "clipId"
										? "--clip"
										: `--${key}`,
							);
							return value ? [[key, value]] : [];
						},
					),
				]),
			);
			break;
		case "command-status":
			result = await commandStatus(
				requiredOption(args, "--project"),
				requiredOption(args, "--command"),
			);
			break;
		case "catalog":
			result = await runCommand({
				projectId: requiredOption(args, "--project"),
				sessionId: optionalOption(args, "--session"),
				kind: "catalog",
				payload: { definition: optionalOption(args, "--definition") },
			});
			break;
		case "edit": {
			const plan = JSON.parse(
				await readFile(requiredOption(args, "--plan"), "utf8"),
			);
			if (!Array.isArray(plan.operations))
				throw new Error("Plan must contain operations");
			result = await runCommand({
				projectId: requiredOption(args, "--project"),
				sessionId: requiredOption(args, "--session"),
				expectedRevision: requiredOption(args, "--expected-revision"),
				idempotencyKey: requiredOption(args, "--key"),
				kind: "edit_batch",
				payload: {
					operations: plan.operations,
					dryRun: args.includes("--dry-run"),
				},
			});
			break;
		}
		case "stage-media":
			result = await runCommand({
				projectId: requiredOption(args, "--project"),
				sessionId: optionalOption(args, "--session"),
				kind: "stage_media",
				payload: { mediaId: requiredOption(args, "--media") },
			});
			break;
		case "transcribe-media": {
			const transcript = await transcribeProjectMedia({
				projectId: requiredOption(args, "--project"),
				sessionId: optionalOption(args, "--session"),
				mediaId: optionalOption(args, "--media"),
				backend: choiceOption(
					args,
					"--backend",
					["local", "hyprwhspr"],
					"local",
				),
				model: optionalOption(args, "--model"),
				language: optionalOption(args, "--language") ?? "en",
				force: args.includes("--force"),
			});
			result = presentTranscriptionResult({
				result: transcript,
				detail: choiceOption(
					args,
					"--detail",
					["text", "segments", "words"],
					"segments",
				),
			});
			break;
		}
		case "apply-cuts": {
			const projectId = requiredOption(args, "--project");
			const planPath = requiredOption(args, "--plan");
			const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
			if (
				typeof plan !== "object" ||
				plan === null ||
				!("ranges" in plan) ||
				!Array.isArray(plan.ranges)
			) {
				throw new Error("Cut plan must contain a ranges array");
			}
			result = await runCommand({
				projectId,
				kind: "apply_cut_plan",
				sessionId: optionalOption(args, "--session"),
				payload: { ranges: plan.ranges },
				expectedRevision: requiredOption(args, "--expected-revision"),
			});
			break;
		}
		case "export-project": {
			const projectId = requiredOption(args, "--project");
			result = await runCommand({
				projectId,
				kind: "export_project",
				sessionId: optionalOption(args, "--session"),
				expectedRevision: requiredOption(args, "--expected-revision"),
				payload: {
					width: numberOption(args, "--width", 1920),
					height: numberOption(args, "--height", 1080),
					fps: numberOption(args, "--fps", 30),
					videoBitrate: numberOption(args, "--video-bitrate", 8_000_000),
					bitrateMode: choiceOption(
						args,
						"--bitrate-mode",
						["variable", "constant"],
						"variable",
					),
					includeAudio: !args.includes("--no-audio"),
					encoder: choiceOption(
						args,
						"--encoder",
						["webcodecs", "native_nvenc"],
						"webcodecs",
					),
					filename:
						optionalOption(args, "--filename") ?? "opencut-agent-export.mp4",
				},
				timeoutMs: 4 * 60 * 60 * 1000,
			});
			break;
		}
		case "plan-speech-cuts": {
			const projectId = requiredOption(args, "--project");
			const mediaId = requiredOption(args, "--media");
			const mediaPath = requiredOption(args, "--media-path");
			const transcriptPath = requiredOption(args, "--transcript");
			const outputPath = requiredOption(args, "--output");
			const thresholdDb = numberOption(args, "--threshold-db", -30);
			const minimumSilenceSeconds = numberOption(
				args,
				"--minimum-silence",
				0.6,
			);
			const alignmentPaths = optionValues(args, "--alignment-pass");
			if (alignmentPaths.length < 2) {
				throw new Error(
					"At least two --alignment-pass files are required; raw ASR timestamps are not edit boundaries",
				);
			}
			const snapshot = await inspectProject(
				projectId,
				optionalOption(args, "--session"),
			);
			if (typeof snapshot !== "object" || snapshot === null) {
				throw new Error("Project snapshot is unavailable");
			}
			const words = await readTranscriptWords(transcriptPath);
			const [alignmentPasses, audio] = await Promise.all([
				Promise.all(alignmentPaths.map(readAlignmentPass)),
				readPcm16Wav(mediaPath),
			]);
			const typedSnapshot = snapshot as Parameters<
				typeof buildSpeechCutPlan
			>[0]["snapshot"];
			const matchingClips =
				typedSnapshot.activeScene.tracks.main.elements.filter(
					(element) => element.type === "video" && element.mediaId === mediaId,
				);
			if (matchingClips.length === 0) {
				throw new Error(
					"The selected media is not present on the main timeline",
				);
			}
			const sourceOriginSeconds = Math.min(
				...matchingClips.map((clip) => clip.trimStart / 120_000),
			);
			const alignment = analyzeFillerBoundaries({
				passes: alignmentPasses,
				audio,
				fps: typedSnapshot.project.fps,
				sourceOriginSeconds,
			});
			const fillerWords = alignment
				.filter((candidate) => candidate.accepted)
				.map((candidate) => ({
					text: candidate.text,
					start: candidate.start,
					end: candidate.end,
				}));
			const silencePlanPath = optionalOption(args, "--silence-plan");
			const silences = silencePlanPath
				? await readSilenceRanges(silencePlanPath)
				: args.includes("--skip-silence")
					? []
					: await detectSilences({
							mediaPath,
							thresholdDb,
							minimumSeconds: minimumSilenceSeconds,
						});
			const plan = buildSpeechCutPlan({
				snapshot: typedSnapshot,
				mediaId,
				words,
				fillerWords,
				silences,
				thresholdDb,
				minimumSilenceSeconds,
			});
			const alignedPlan = {
				...plan,
				alignment: {
					method: "multi-pass-wav2vec2-ctc-with-acoustic-boundary-gate",
					passes: alignmentPaths,
					acceptedFillers: alignment.filter((candidate) => candidate.accepted)
						.length,
					rejectedFillers: alignment.filter((candidate) => !candidate.accepted)
						.length,
					candidates: alignment,
				},
			};
			await writeFile(outputPath, `${JSON.stringify(alignedPlan, null, 2)}\n`);
			result = alignedPlan;
			break;
		}
		default:
			throw new Error(
				"Usage: opencut-agent <projects|inspect|catalog|edit|command-status|stage-media|transcribe-media|plan-speech-cuts|apply-cuts|export-project> [options]. edit requires --project --session --expected-revision --key --plan and optionally --dry-run. inspect defaults to overview; --detail media|timeline|clip|full reveals more.",
			);
	}
	console.log(JSON.stringify(result, null, 2));
	if (
		typeof result === "object" &&
		result &&
		"success" in result &&
		result.success === false
	)
		process.exitCode = 1;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

function numberOption(args: string[], name: string, fallback: number): number {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(args[index + 1]);
	if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
	return value;
}

function requiredOption(args: string[], name: string): string {
	const index = args.indexOf(name);
	const value = index >= 0 ? args[index + 1] : undefined;
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function optionalOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function choiceOption<const T extends string>(
	args: string[],
	name: string,
	choices: readonly T[],
	fallback: T,
): T {
	const value = optionalOption(args, name);
	if (value === undefined) return fallback;
	const match = choices.find((choice) => choice === value);
	if (!match) throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	return match;
}

function optionValues(args: string[], name: string): string[] {
	return args.flatMap((argument, index) =>
		argument === name && args[index + 1] ? [args[index + 1]!] : [],
	);
}
