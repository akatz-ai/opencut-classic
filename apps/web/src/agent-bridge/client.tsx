"use client";

import { useEffect, useRef, useState } from "react";
import { applyRoughCut, roughCutCatalog } from "./roughcut";
import type {
	AgentBridgeCommand,
	AgentBridgeCommandResult,
	AgentProjectSnapshot,
} from "@/agent-bridge/types";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { floatToFrameRate, frameRateToFloat } from "@/fps/utils";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { SceneTracks } from "@/timeline";
import type { ExportOptions } from "@/export";
import type { StreamTargetChunk } from "mediabunny";
import { NativeExportSession } from "@/services/native-media/client";

const STATE_HEARTBEAT_MS = 1000;
const COMMAND_POLL_MS = 350;
type LiveSession = {
	sessionId: string;
	paused: boolean;
	disposed: boolean;
	pointerDown: boolean;
};

declare global {
	interface Window {
		__opencutAgentSnapshot?: AgentProjectSnapshot;
	}
}

export function AgentBridge() {
	const editor = useEditor();
	const [paused, setPaused] = useState(false);
	const sessionRef = useRef<LiveSession | null>(null);

	useEffect(() => {
		let disposed = false;
		const session: LiveSession = {
			sessionId: crypto.randomUUID(),
			paused: false,
			disposed: false,
			pointerDown: false,
		};
		sessionRef.current = session;
		const down = () => {
			session.pointerDown = true;
		};
		const up = () => {
			session.pointerDown = false;
		};
		window.addEventListener("pointerdown", down);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
		window.addEventListener("blur", up);
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		let publishTimer: ReturnType<typeof setTimeout> | null = null;
		const projectId = editor.project.getActive().metadata.id;

		const publish = async () => {
			if (disposed) return;
			const snapshot = buildAgentSnapshot({ editor, session });
			window.__opencutAgentSnapshot = snapshot;
			await fetch("/api/agent-bridge/state", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(snapshot),
			}).catch((error: unknown) => {
				console.warn("[agent-bridge] Failed to publish state:", error);
			});
		};

		const schedulePublish = () => {
			if (publishTimer) clearTimeout(publishTimer);
			publishTimer = setTimeout(() => void publish(), 100);
		};

		const poll = async () => {
			if (disposed) return;
			try {
				const response = await fetch(
					`/api/agent-bridge/commands?projectId=${encodeURIComponent(projectId)}&sessionId=${session.sessionId}`,
					{ cache: "no-store" },
				);
				if (response.ok) {
					const body: unknown = await response.json();
					const command = readCommand(body);
					if (command) await executeAgentCommand({ editor, command, session });
				}
			} catch (error) {
				console.warn("[agent-bridge] Command poll failed:", error);
			} finally {
				if (!disposed)
					pollTimer = setTimeout(() => void poll(), COMMAND_POLL_MS);
			}
		};

		const unsubscribers = [
			editor.project.subscribe(schedulePublish),
			editor.scenes.subscribe(schedulePublish),
			editor.media.subscribe(schedulePublish),
			editor.playback.onSeek(schedulePublish),
		];
		void publish();
		void poll();
		const heartbeat = setInterval(() => void publish(), STATE_HEARTBEAT_MS);

		return () => {
			disposed = true;
			session.disposed = true;
			window.removeEventListener("pointerdown", down);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			window.removeEventListener("blur", up);
			if (pollTimer) clearTimeout(pollTimer);
			if (publishTimer) clearTimeout(publishTimer);
			clearInterval(heartbeat);
			for (const unsubscribe of unsubscribers) unsubscribe();
			delete window.__opencutAgentSnapshot;
		};
	}, [editor]);

	return (
		<button
			type="button"
			className="fixed bottom-1 right-3 z-50 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground border"
			title="Pause or allow agent commands for this editor window"
			aria-pressed={paused}
			onClick={() => {
				if (sessionRef.current) sessionRef.current.paused = !paused;
				setPaused(!paused);
			}}
		>
			{paused ? "Agent paused" : "Agent ready"}
		</button>
	);
}

function buildAgentSnapshot({
	editor,
	session,
}: {
	editor: EditorCore;
	session: LiveSession;
}): AgentProjectSnapshot {
	const project = editor.project.getActive();
	const activeScene = editor.scenes.getActiveScene();
	const tracks = stripRuntimeBuffers(activeScene.tracks);
	const media = editor.media.getAssets().map((asset) => ({
		id: asset.id,
		name: asset.name,
		type: asset.type,
		sizeBytes: asset.file.size,
		durationSeconds: asset.duration,
		width: asset.width,
		height: asset.height,
		fps: asset.fps,
		hasAudio: asset.hasAudio,
		codec: asset.codec,
		proxyState: asset.proxyState,
	}));
	const revisionInput = JSON.stringify({
		projectId: project.metadata.id,
		settings: project.settings,
		activeSceneId: activeScene.id,
		tracks,
		media,
	});
	return {
		sessionId: session.sessionId,
		agentPaused: session.paused,
		selectedElements: editor.selection.getSelectedElements(),
		revision: hashString(revisionInput),
		capturedAt: new Date().toISOString(),
		project: {
			id: project.metadata.id,
			name: project.metadata.name,
			durationSeconds: editor.timeline.getTotalDuration() / TICKS_PER_SECOND,
			fps: frameRateToFloat(project.settings.fps),
			canvasSize: project.settings.canvasSize,
		},
		activeScene: {
			id: activeScene.id,
			name: activeScene.name,
			tracks,
		},
		media,
		playheadSeconds: editor.playback.getCurrentTime() / TICKS_PER_SECOND,
	};
}

function stripRuntimeBuffers<T>(value: T): T {
	// JSON serialization is the bridge boundary and preserves this data-only model.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return JSON.parse(
		JSON.stringify(value, (key, item: unknown) =>
			key === "buffer" ? undefined : item,
		),
	) as T;
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function readCommand(value: unknown): AgentBridgeCommand | null {
	if (typeof value !== "object" || value === null || !("command" in value)) {
		return null;
	}
	const command = value.command;
	if (
		typeof command !== "object" ||
		command === null ||
		!("id" in command) ||
		typeof command.id !== "string" ||
		!("kind" in command) ||
		!(
			command.kind === "stage_media" ||
			command.kind === "edit_batch" ||
			command.kind === "catalog" ||
			command.kind === "apply_cut_plan" ||
			command.kind === "export_project"
		)
	) {
		return null;
	}
	if (
		!("projectId" in command) ||
		typeof command.projectId !== "string" ||
		!("payload" in command) ||
		typeof command.payload !== "object" ||
		command.payload === null ||
		!("createdAt" in command) ||
		typeof command.createdAt !== "string"
	) {
		return null;
	}
	return {
		...("sessionId" in command && typeof command.sessionId === "string"
			? { sessionId: command.sessionId }
			: {}),
		...("expiresAt" in command && typeof command.expiresAt === "string"
			? { expiresAt: command.expiresAt }
			: {}),
		id: command.id,
		projectId: command.projectId,
		kind: command.kind,
		payload: Object.fromEntries(Object.entries(command.payload)),
		createdAt: command.createdAt,
		...("expectedRevision" in command &&
		typeof command.expectedRevision === "string"
			? { expectedRevision: command.expectedRevision }
			: {}),
		...("deliveredAt" in command && typeof command.deliveredAt === "string"
			? { deliveredAt: command.deliveredAt }
			: {}),
	};
}

async function executeAgentCommand({
	editor,
	command,
	session,
}: {
	editor: EditorCore;
	command: AgentBridgeCommand;
	session: LiveSession;
}): Promise<void> {
	let result: AgentBridgeCommandResult;
	try {
		const before = buildAgentSnapshot({ editor, session });
		const assertCurrent = () => {
			if (session.disposed || session.paused)
				throw new Error("Agent session is closed or paused");
			if (
				command.sessionId !== session.sessionId ||
				command.projectId !== editor.project.getActive().metadata.id
			)
				throw new Error("Agent session or project mismatch");
			if (!command.expiresAt || Date.now() > Date.parse(command.expiresAt))
				throw new Error("Agent command expired before execution");
			if (buildAgentSnapshot({ editor, session }).revision !== before.revision)
				throw new Error("Editor changed during planning; inspect and re-plan");
			if (command.kind === "edit_batch" || command.kind === "apply_cut_plan") {
				const focused = document.activeElement;
				if (
					editor.playback.getIsPlaying() ||
					editor.project.getExportState().isExporting ||
					editor.timeline.isPreviewActive() ||
					session.pointerDown ||
					focused?.matches(
						"input,textarea,[contenteditable=true],[role=slider]",
					)
				)
					throw new Error(
						"Editor busy: finish playback or the current interaction first",
					);
			}
		};
		assertCurrent();
		if (
			command.expectedRevision &&
			command.expectedRevision !== before.revision
		) {
			throw new Error(
				`Revision mismatch: expected ${command.expectedRevision}, current ${before.revision}`,
			);
		}

		let commandResult: Record<string, unknown>;
		if (command.kind === "edit_batch") {
			if (!command.expectedRevision)
				throw new Error("expectedRevision is required");
			commandResult = applyRoughCut({
				editor,
				snapshot: before,
				payload: command.payload,
				assertCurrent,
			});
		} else if (command.kind === "catalog") {
			commandResult = roughCutCatalog(command.payload.definition);
		} else if (command.kind === "stage_media") {
			commandResult = await stageMedia({ editor, payload: command.payload });
		} else if (command.kind === "apply_cut_plan") {
			commandResult = await applyCutPlan({
				editor,
				payload: command.payload,
				assertCurrent,
			});
		} else {
			commandResult = await exportProject({ editor, payload: command.payload });
		}
		await editor.save.flush();
		const after = buildAgentSnapshot({ editor, session });
		window.__opencutAgentSnapshot = after;
		result = {
			commandId: command.id,
			success: true,
			completedAt: new Date().toISOString(),
			revision: after.revision,
			result: commandResult,
		};
	} catch (error) {
		result = {
			commandId: command.id,
			success: false,
			completedAt: new Date().toISOString(),
			error: error instanceof Error ? error.message : String(error),
		};
	}
	await fetch(`/api/agent-bridge/commands/${command.id}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ projectId: command.projectId, result }),
	});
}

async function stageMedia({
	editor,
	payload,
}: {
	editor: EditorCore;
	payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const mediaId = payload.mediaId;
	if (typeof mediaId !== "string") throw new Error("mediaId is required");
	const asset = editor.media
		.getAssets()
		.find((candidate) => candidate.id === mediaId);
	if (!asset) throw new Error(`Media asset ${mediaId} was not found`);
	const preferProxy = payload.preferProxy === true;
	const stagedFile = preferProxy && asset.proxy ? asset.proxy.file : asset.file;
	const stagedName =
		preferProxy && asset.proxy ? `${asset.name}.proxy.mp4` : asset.name;
	const projectId = editor.project.getActive().metadata.id;
	const query = new URLSearchParams({
		projectId,
		mediaId,
		filename: stagedName,
	});
	const response = await fetch(`/api/agent-bridge/artifacts?${query}`, {
		method: "POST",
		body: stagedFile,
	});
	if (!response.ok) throw new Error(`Media staging failed: ${response.status}`);
	const result: Record<string, unknown> = await response.json();
	return { ...result, usedProxy: stagedFile === asset.proxy?.file };
}

async function applyCutPlan({
	editor,
	payload,
	assertCurrent,
}: {
	editor: EditorCore;
	payload: Record<string, unknown>;
	assertCurrent: () => void;
}): Promise<Record<string, unknown>> {
	if (!Array.isArray(payload.ranges))
		throw new Error("ranges must be an array");
	const ranges = payload.ranges.map((value) => {
		if (
			typeof value !== "object" ||
			value === null ||
			!("startSeconds" in value) ||
			typeof value.startSeconds !== "number" ||
			!("endSeconds" in value) ||
			typeof value.endSeconds !== "number"
		) {
			throw new Error("Every cut requires numeric startSeconds and endSeconds");
		}
		return {
			startTime: mediaTimeFromSeconds({ seconds: value.startSeconds }),
			endTime: mediaTimeFromSeconds({ seconds: value.endSeconds }),
			reason:
				"reason" in value && typeof value.reason === "string"
					? value.reason
					: undefined,
		};
	});
	const before = editor.scenes.getActiveScene().tracks;
	const response = await fetch("/api/agent-bridge/plan-cuts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tracks: before, ranges }),
	});
	if (!response.ok) {
		throw new Error(`Native cut planning failed: ${await response.text()}`);
	}
	const nativeResult: unknown = await response.json();
	if (
		typeof nativeResult !== "object" ||
		nativeResult === null ||
		!("tracks" in nativeResult) ||
		!("removedDuration" in nativeResult) ||
		typeof nativeResult.removedDuration !== "number" ||
		!("createdElementIds" in nativeResult) ||
		!Array.isArray(nativeResult.createdElementIds)
	) {
		throw new Error("Native cut planner returned an invalid result");
	}
	// The Rust planner preserves the complete validated track document and only
	// changes timeline timing, trims, names, and generated IDs.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const after = nativeResult.tracks as SceneTracks;
	assertCurrent();
	const wasRippleEnabled = editor.command.isRippleEnabled;
	try {
		// The native planner has already applied one global ripple across every
		// track. Disable the interactive ripple reactor for this snapshot command
		// so a user's toolbar setting cannot shift the result a second time.
		editor.command.isRippleEnabled = false;
		editor.command.execute({
			command: new TracksSnapshotCommand({ before, after }),
		});
	} finally {
		editor.command.isRippleEnabled = wasRippleEnabled;
	}
	return {
		removedSeconds: nativeResult.removedDuration / TICKS_PER_SECOND,
		createdElementIds: nativeResult.createdElementIds,
		rangeCount: ranges.length,
	};
}

async function exportProject({
	editor,
	payload,
}: {
	editor: EditorCore;
	payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const width = positiveInteger({ value: payload.width, label: "width" });
	const height = positiveInteger({ value: payload.height, label: "height" });
	const fps = positiveNumber({ value: payload.fps, label: "fps" });
	const videoBitrate = positiveInteger({
		value: payload.videoBitrate,
		label: "videoBitrate",
	});
	const includeAudio = payload.includeAudio !== false;
	const bitrateMode =
		payload.bitrateMode === "constant" ? "constant" : "variable";
	const encoder =
		payload.encoder === "native_nvenc" ? "native_nvenc" : "webcodecs";
	const filename =
		typeof payload.filename === "string" && payload.filename.trim()
			? payload.filename
			: "opencut-agent-export.mp4";
	let artifact: Record<string, unknown> | null = null;
	const stageArtifact = async (stream: ReadableStream<Uint8Array>) => {
		const projectId = editor.project.getActive().metadata.id;
		const query = new URLSearchParams({
			projectId,
			mediaId: "render",
			filename,
		});
		const body = await new Response(stream).blob();
		const response = await fetch(`/api/agent-bridge/artifacts?${query}`, {
			method: "POST",
			body,
		});
		if (!response.ok) {
			throw new Error(`Export artifact staging failed: ${response.status}`);
		}
		const value: unknown = await response.json();
		if (typeof value !== "object" || value === null) {
			throw new Error("Export artifact response is invalid");
		}
		artifact = Object.fromEntries(Object.entries(value));
	};
	let browserCaptureSession: NativeExportSession | null = null;
	let browserCaptureCompleted = false;
	try {
		browserCaptureSession =
			encoder === "webcodecs" ? await NativeExportSession.start() : null;
		const unavailableWritable = new WritableStream<StreamTargetChunk>({
			write: () => {
				throw new Error("The selected export encoder has no video destination");
			},
		});
		const result = await editor.project.export({
			options: {
				format: "mp4",
				quality: "high",
				fps: floatToFrameRate(fps),
				includeAudio,
				width,
				height,
				videoBitrate,
				bitrateMode,
				encoder,
			} satisfies ExportOptions,
			destination: browserCaptureSession
				? {
						writable: browserCaptureSession.createVideoDestination(),
						writeResponse: stageArtifact,
					}
				: {
						writable: unavailableWritable,
						writeResponse: stageArtifact,
					},
		});
		if (!result.success) {
			throw new Error(
				result.cancelled
					? "Agent export was cancelled"
					: (result.error ?? "Agent export failed"),
			);
		}
		if (browserCaptureSession && !artifact) {
			const response = await browserCaptureSession.finalize({
				spec: null,
				videoTranscode:
					bitrateMode === "constant"
						? {
								fps: floatToFrameRate(fps),
								bitrate: videoBitrate,
								bitrateMode,
							}
						: undefined,
			});
			if (!response.body) throw new Error("Browser export artifact is missing");
			await stageArtifact(response.body);
			browserCaptureCompleted = true;
		}
		if (!artifact) throw new Error("Agent export did not produce an artifact");
		return { ...result, encoder, artifact };
	} finally {
		if (browserCaptureSession && !browserCaptureCompleted) {
			await browserCaptureSession.cancel();
		}
	}
}

function positiveInteger({
	value,
	label,
}: {
	value: unknown;
	label: string;
}): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function positiveNumber({
	value,
	label,
}: {
	value: unknown;
	label: string;
}): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive number`);
	}
	return value;
}
