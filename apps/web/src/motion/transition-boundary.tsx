"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";
import { TRANSITION_MIME, isTransitionKind, transitionLabel } from "./catalog";
import {
	selectTransition,
	updateTransition,
	useSelectedTransition,
	type MotionEdge,
} from "./transition-selection";

export function TransitionBoundary({
	element,
	track,
	pixelsPerSecond,
	height,
}: {
	element: TimelineElement;
	track: TimelineTrack;
	pixelsPerSecond: number;
	height: number;
}) {
	const editor = useEditor();
	const selected = useSelectedTransition();
	const [over, setOver] = useState(false);
	const [draft, setDraft] = useState<number | null>(null);
	const sorted = [...track.elements].sort((a, b) => a.startTime - b.startTime);
	const previous = sorted[sorted.findIndex((e) => e.id === element.id) - 1];
	const cut =
		(element.type === "video" || element.type === "image") &&
		previous &&
		(previous.type === "video" || previous.type === "image") &&
		Math.abs(previous.startTime + previous.duration - element.startTime) <= 0.5;
	if (element.type === "audio" || element.type === "effect") return null;
	const enter = element.motion?.enter;
	const exit = element.motion?.exit;
	function choose(edge: MotionEdge) {
		selectTransition({
			editor,
			target: {
				trackId: track.id,
				elementId: element.id,
				edge,
			},
		});
		useAssetsPanelStore.getState().setActiveTab("transitions");
	}
	return (
		<>
			{(cut || enter) && (
				<div
					role="group"
					aria-label={`Transition controls for ${element.name}`}
					className="absolute z-20"
					style={{
						left: 0,
						top: Math.max(2, height / 2 - 10),
						height: 20,
						width: enter
							? Math.max(
									22,
									(draft ?? enter.duration / TICKS_PER_SECOND) *
										pixelsPerSecond,
								)
							: 22,
					}}
					onDragOver={(e) => {
						if (!cut || !e.dataTransfer.types.includes(TRANSITION_MIME)) return;
						e.preventDefault();
						e.stopPropagation();
						e.dataTransfer.dropEffect = "copy";
						setOver(true);
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(e) => {
						if (!e.dataTransfer.types.includes(TRANSITION_MIME)) return;
						e.preventDefault();
						e.stopPropagation();
						setOver(false);
						const kind = e.dataTransfer.getData(TRANSITION_MIME);
						if (!cut || !isTransitionKind(kind)) return;
						try {
							updateTransition({
								editor,
								target: {
									trackId: track.id,
									elementId: element.id,
									edge: "cut",
								},
								transition: {
									kind,
									duration:
										enter?.duration ?? mediaTimeFromSeconds({ seconds: 0.4 }),
									easing: enter?.easing ?? "smooth",
								},
							});
							choose("cut");
						} catch (error) {
							toast.error(
								String(error instanceof Error ? error.message : error),
							);
						}
					}}
				>
					<button
						type="button"
						onMouseDown={(e) => e.stopPropagation()}
						aria-label={
							enter
								? `Edit ${transitionLabel(enter.kind)} transition on ${element.name}`
								: `Add transition before ${element.name}`
						}
						title={
							enter
								? `${transitionLabel(enter.kind)} · ${(enter.duration / TICKS_PER_SECOND).toFixed(2)}s`
								: "Add transition"
						}
						className={cn(
							"flex h-full w-full items-center justify-center overflow-hidden rounded-sm border text-[10px] shadow-sm",
							enter
								? "border-cyan-200/70 bg-cyan-950/95 text-cyan-100"
								: "border-white/30 bg-neutral-900/90 text-white/70 hover:border-primary hover:text-primary",
							(over ||
								(selected?.elementId === element.id &&
									selected.edge !== "exit")) &&
								"ring-2 ring-primary",
						)}
						onClick={(e) => {
							e.stopPropagation();
							choose(element.motion?.fromPrevious || !enter ? "cut" : "enter");
						}}
					>
						{enter ? (
							<svg
								viewBox="0 0 20 14"
								width="18"
								height="14"
								aria-hidden="true"
							>
								<path
									d="M2 2 10 7 2 12ZM18 2 10 7 18 12Z"
									fill="currentColor"
								/>
							</svg>
						) : (
							"+"
						)}
					</button>
					{enter &&
						selected?.elementId === element.id &&
						selected.edge !== "exit" && (
							<button
								type="button"
								aria-label={`Resize transition on ${element.name}`}
								onMouseDown={(e) => e.stopPropagation()}
								title="Drag to change duration"
								className="absolute -right-1 top-0 h-full w-2 cursor-ew-resize rounded bg-primary"
								onClick={(e) => e.stopPropagation()}
								onPointerDown={(e) => {
									e.stopPropagation();
									e.preventDefault();
									e.currentTarget.setPointerCapture(e.pointerId);
									e.currentTarget.dataset.startX = String(e.clientX);
								}}
								onPointerMove={(e) => {
									if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
									const value =
										enter.duration / TICKS_PER_SECOND +
										(e.clientX - Number(e.currentTarget.dataset.startX)) /
											pixelsPerSecond;
									setDraft(
										Math.max(
											0.01,
											Math.min(element.duration / TICKS_PER_SECOND, value),
										),
									);
								}}
								onPointerUp={(e) => {
									if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
									e.currentTarget.releasePointerCapture(e.pointerId);
									try {
										if (draft !== null)
											updateTransition({
												editor,
												target: {
													trackId: track.id,
													elementId: element.id,
													edge: element.motion?.fromPrevious ? "cut" : "enter",
												},
												transition: {
													...enter,
													duration: mediaTimeFromSeconds({ seconds: draft }),
												},
											});
									} catch (error) {
										toast.error(
											String(error instanceof Error ? error.message : error),
										);
									}
									setDraft(null);
								}}
								onPointerCancel={() => setDraft(null)}
							/>
						)}
				</div>
			)}
			{exit && (
				<button
					type="button"
					aria-label={`Edit exit transition on ${element.name}`}
					className="absolute right-1 bottom-1 z-20 rounded border border-cyan-200/50 bg-cyan-950 px-1 text-[9px] text-cyan-100"
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						choose("exit");
					}}
				>
					OUT
				</button>
			)}
		</>
	);
}
