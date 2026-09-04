#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inspectProject, listProjects, runCommand } from "./client";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = new McpServer(
	{ name: "opencut", version: "0.1.0" },
	{
		instructions:
			"Inspect the active OpenCut project before editing. Mutations require the exact current revision. Stage media only when analysis needs source bytes. Apply cut plans only after presenting their ranges and total removed duration to the user.",
	},
);

server.registerTool(
	"list_projects",
	{
		description:
			"List OpenCut projects currently connected to the local bridge.",
		inputSchema: {},
		annotations: { readOnlyHint: true },
	},
	async () => toolResult(await listProjects()),
);

server.registerTool(
	"inspect_project",
	{
		description:
			"Return the live project, active scene, complete timeline tracks, media metadata, playhead, and revision.",
		inputSchema: { project_id: z.string() },
		annotations: { readOnlyHint: true },
	},
	async ({ project_id }) => toolResult(await inspectProject(project_id)),
);

server.registerTool(
	"stage_media",
	{
		description:
			"Stream one OpenCut media asset to a temporary local artifact for transcription or FFmpeg analysis.",
		inputSchema: { project_id: z.string(), media_id: z.string() },
		annotations: { readOnlyHint: true },
	},
	async ({ project_id, media_id }) =>
		toolResult(
			await runCommand({
				projectId: project_id,
				kind: "stage_media",
				payload: { mediaId: media_id },
			}),
		),
);

server.registerTool(
	"media_contact_sheet",
	{
		description:
			"Return a labeled JPEG contact sheet from exact source timestamps. Uses an existing preview proxy when available.",
		inputSchema: {
			project_id: z.string(),
			media_id: z.string(),
			times_seconds: z.array(z.number().nonnegative()).min(1).max(36),
		},
		annotations: { readOnlyHint: true },
	},
	async ({ project_id, media_id, times_seconds }) => {
		const staged = await runCommand({
			projectId: project_id,
			kind: "stage_media",
			payload: { mediaId: media_id, preferProxy: true },
			timeoutMs: 600_000,
		});
		const mediaPath = readStagedPath(staged);
		const sheetPath = await createContactSheet({
			mediaPath,
			times: times_seconds,
		});
		const data = Buffer.from(await readFile(sheetPath)).toString("base64");
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{ sheetPath, timesSeconds: times_seconds },
						null,
						2,
					),
				},
				{ type: "image" as const, data, mimeType: "image/jpeg" },
			],
			structuredContent: { sheetPath, timesSeconds: times_seconds },
		};
	},
);

server.registerTool(
	"apply_cut_plan",
	{
		description:
			"Apply reviewed global timeline cut ranges, close the gaps across all tracks, save, and return the new revision. The whole edit is one undo step.",
		inputSchema: {
			project_id: z.string(),
			expected_revision: z.string(),
			ranges: z.array(
				z.object({
					startSeconds: z.number().nonnegative(),
					endSeconds: z.number().positive(),
					reason: z.string().optional(),
				}),
			),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
		},
	},
	async ({ project_id, expected_revision, ranges }) =>
		toolResult(
			await runCommand({
				projectId: project_id,
				kind: "apply_cut_plan",
				payload: { ranges },
				expectedRevision: expected_revision,
			}),
		),
);

server.registerTool(
	"export_project",
	{
		description:
			"Render the live OpenCut project and return a temporary local MP4 artifact path. Browser WebCodecs is the measured-fast default; native NVIDIA NVENC is experimental.",
		inputSchema: {
			project_id: z.string(),
			expected_revision: z.string(),
			width: z.number().int().positive().default(1920),
			height: z.number().int().positive().default(1080),
			fps: z.number().positive().default(30),
			video_bitrate: z.number().int().min(100_000).max(200_000_000),
			bitrate_mode: z.enum(["variable", "constant"]).default("variable"),
			encoder: z.enum(["webcodecs", "native_nvenc"]).default("webcodecs"),
			include_audio: z.boolean().default(true),
			filename: z.string().default("opencut-agent-export.mp4"),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
		},
	},
	async ({
		project_id,
		expected_revision,
		width,
		height,
		fps,
		video_bitrate,
		bitrate_mode,
		encoder,
		include_audio,
		filename,
	}) =>
		toolResult(
			await runCommand({
				projectId: project_id,
				kind: "export_project",
				expectedRevision: expected_revision,
				payload: {
					width,
					height,
					fps,
					videoBitrate: video_bitrate,
					bitrateMode: bitrate_mode,
					encoder,
					includeAudio: include_audio,
					filename,
				},
				timeoutMs: 4 * 60 * 60 * 1000,
			}),
		),
);

await server.connect(new StdioServerTransport());

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		structuredContent: toRecord(value),
	};
}

function toRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { value };
	}
	return Object.fromEntries(Object.entries(value));
}

function readStagedPath(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		"result" in value &&
		typeof value.result === "object" &&
		value.result !== null &&
		"path" in value.result &&
		typeof value.result.path === "string"
	) {
		return value.result.path;
	}
	throw new Error("Media staging did not return an artifact path");
}

async function createContactSheet({
	mediaPath,
	times,
}: {
	mediaPath: string;
	times: number[];
}): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opencut-contact-sheet-"));
	const frames = times.map((time, index) => ({
		time,
		path: join(
			directory,
			`${String(index + 1).padStart(2, "0")}-${time.toFixed(3)}s.jpg`,
		),
	}));
	let next = 0;
	async function worker() {
		while (next < frames.length) {
			const frame = frames[next++];
			const process = Bun.spawn([
				"ffmpeg",
				"-hide_banner",
				"-loglevel",
				"error",
				"-ss",
				String(frame.time),
				"-i",
				mediaPath,
				"-frames:v",
				"1",
				"-vf",
				"scale=480:-2",
				frame.path,
			]);
			if ((await process.exited) !== 0) throw new Error("Frame capture failed");
		}
	}
	await Promise.all(Array.from({ length: Math.min(6, frames.length) }, worker));
	const output = join(directory, "contact-sheet.jpg");
	const montage = Bun.spawn([
		"magick",
		"montage",
		...frames.map((frame) => frame.path),
		"-thumbnail",
		"480x270",
		"-tile",
		"4x",
		"-geometry",
		"+8+20",
		"-background",
		"#111111",
		"-fill",
		"white",
		"-pointsize",
		"14",
		"-set",
		"label",
		"%f",
		output,
	]);
	if ((await montage.exited) !== 0)
		throw new Error("Contact sheet assembly failed");
	return output;
}
