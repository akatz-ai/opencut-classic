import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportDestination, ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { collectAudioClips, createTimelineAudioBuffer } from "@/media/audio";
import { formatTimecode } from "opencut-wasm";
import { downloadBlob } from "@/utils/browser";
import {
	getNativeMediaHealth,
	NativeExportSession,
	type NativeAudioClip,
} from "@/services/native-media/client";
import { shouldMaintainPitch } from "@/retime/rate";
import { hasAnimatedVolume } from "@/timeline/audio-state";
import { TICKS_PER_SECOND } from "@/wasm";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(
				/:/g,
				"-",
			);
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		destination,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		destination?: ExportDestination;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio } = options;

		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;
			const nativeMediaHealth =
				format === "mp4" && destination?.writeResponse
					? await getNativeMediaHealth()
					: null;
			const nativeAudioClips = includeAudio
				? await collectAudioClips({ tracks, mediaAssets })
				: [];
			const hasAnimatedAudio = nativeAudioClips.some((clip) =>
				hasAnimatedVolume({ element: clip.timelineElement }),
			);
			const shouldUseNativeExport = Boolean(
				includeAudio &&
					nativeMediaHealth?.available &&
					destination?.writeResponse &&
					!hasAnimatedAudio,
			);

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio && !shouldUseNativeExport) {
				onProgress?.({ progress: 0.05 });
				audioBuffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
				});
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			let nativeSession: NativeExportSession | null = null;
			let nativeExportCompleted = false;
			if (shouldUseNativeExport) {
				nativeSession = await NativeExportSession.start();
			}
			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio: !!includeAudio && !shouldUseNativeExport,
				audioBuffer: audioBuffer || undefined,
				destination: nativeSession
					? { writable: nativeSession.createVideoDestination() }
					: destination,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio && !shouldUseNativeExport
					? 0.05 + progress * 0.95
					: shouldUseNativeExport
						? progress * 0.9
						: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const output = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					await nativeSession?.cancel();
					return { success: false, cancelled: true };
				}

				if (!output) {
					await nativeSession?.cancel();
					return { success: false, error: "Export failed to produce buffer" };
				}

				if (nativeSession && destination?.writeResponse) {
					onProgress?.({ progress: 0.92 });
					const clips: NativeAudioClip[] = nativeAudioClips
						.filter((clip) => !clip.muted)
						.map((clip) => ({
							sourceKey: clip.sourceKey,
							file: clip.file,
							startTime: clip.startTime,
							duration: clip.duration,
							trimStart: clip.trimStart,
							rate: clip.retime?.rate ?? 1,
							maintainPitch: shouldMaintainPitch({
								rate: clip.retime?.rate ?? 1,
								maintainPitch: clip.retime?.maintainPitch,
							}),
							volume: clip.volume,
						}));
					const response = await nativeSession.finalize({
						spec: {
							durationSeconds: duration / TICKS_PER_SECOND,
							sampleRate: 48_000,
							clips,
						},
					});
					if (!response.body) {
						throw new Error("Native export response body is missing");
					}
					await destination.writeResponse(response.body);
					nativeExportCompleted = true;
					onProgress?.({ progress: 1 });
					return { success: true, savedToFile: true };
				}

				return {
					success: true,
					buffer: output.buffer,
					savedToFile: output.savedToFile,
				};
			} finally {
				clearInterval(cancelInterval);
				if (nativeSession && !nativeExportCompleted) {
					await nativeSession.cancel();
				}
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
