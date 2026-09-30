"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { mediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { transitionLabel } from "./catalog";
import { TransitionPreview } from "./transition-preview";
import {
	removeSelectedTransition,
	updateTransition,
	type MotionTarget,
} from "./transition-selection";
import type { ClipTransition } from "./types";

export function TransitionInspector({ target }: { target: MotionTarget }) {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const found = editor.timeline.getElementsWithTracks({
		elements: [target],
	})[0];
	const transition =
		found?.element.motion?.[target.edge === "exit" ? "exit" : "enter"];
	const [preview, setPreview] = useState(false);
	const [draft, setDraft] = useState<string | null>(null);
	const seconds = transition ? transition.duration / TICKS_PER_SECOND : 0;
	function update(patch: Partial<ClipTransition>) {
		if (!transition) return;
		try {
			updateTransition({
				editor,
				target,
				transition: { ...transition, ...patch },
			});
		} catch (error) {
			toast.error(String(error instanceof Error ? error.message : error));
		}
		setDraft(null);
	}
	function commitDuration() {
		if (draft === null) return;
		const value = Number(draft);
		if (!Number.isFinite(value) || value <= 0) {
			toast.error("Duration must be greater than zero.");
			setDraft(null);
			return;
		}
		if (value === seconds) {
			setDraft(null);
			return;
		}
		update({ duration: mediaTimeFromSeconds({ seconds: value }) });
	}
	return (
		<div
			className="panel bg-background flex h-full flex-col overflow-auto rounded-sm border"
			aria-label="Transition inspector"
		>
			<div className="flex h-11 shrink-0 items-center border-b px-4 text-sm font-medium">
				{target.edge === "cut"
					? "Transition"
					: target.edge === "enter"
						? "Entrance animation"
						: "Exit animation"}
			</div>
			<div className="space-y-5 p-4">
				{transition ? (
					<>
						<div className="flex items-center gap-3">
							<div
								className="w-24 shrink-0 overflow-hidden rounded-md"
								onMouseEnter={() => setPreview(true)}
								onMouseLeave={() => setPreview(false)}
							>
								<TransitionPreview
									kind={transition.kind}
									playing={preview}
									exit={target.edge === "exit"}
								/>
							</div>
							<div className="min-w-0">
								<p className="text-sm font-medium">
									{transitionLabel(transition.kind)}
								</p>
								<p className="mt-1 truncate text-xs text-muted-foreground">
									{found?.element.name}
								</p>
								<button
									type="button"
									className="mt-1 text-xs text-primary"
									onClick={() =>
										useAssetsPanelStore.getState().setActiveTab("transitions")
									}
								>
									Change transition
								</button>
							</div>
						</div>
						<div className="space-y-3">
							<div className="flex items-center justify-between gap-3">
								<label htmlFor="transition-duration" className="text-xs">
									Duration
								</label>
								<div className="flex items-center gap-2">
									<Input
										id="transition-duration"
										aria-label="Transition duration"
										type="number"
										min="0.01"
										step="0.05"
										value={draft ?? seconds.toFixed(2)}
										className="h-8 w-24"
										onChange={(e) => setDraft(e.target.value)}
										onBlur={commitDuration}
										onKeyDown={(e) => {
											if (e.key === "Enter") e.currentTarget.blur();
											if (e.key === "Escape") {
												e.preventDefault();
												e.stopPropagation();
												setDraft(null);
											}
										}}
									/>
									<span className="text-xs text-muted-foreground">s</span>
								</div>
							</div>
							<input
								type="range"
								aria-label="Transition duration slider"
								min="0.05"
								max={Math.max(
									0.05,
									Math.min(
										5,
										(found?.element.duration ?? TICKS_PER_SECOND) /
											TICKS_PER_SECOND,
									),
								)}
								step="0.05"
								value={draft ?? seconds}
								className="w-full accent-primary"
								onChange={(e) => setDraft(e.target.value)}
								onPointerUp={commitDuration}
								onKeyUp={commitDuration}
								onBlur={commitDuration}
							/>
						</div>
						<label className="flex items-center justify-between gap-4 text-xs">
							Timing
							<select
								aria-label="Transition easing"
								value={transition.easing}
								className="rounded border bg-background p-2"
								onChange={(e) => {
									if (
										e.target.value === "linear" ||
										e.target.value === "smooth"
									)
										update({ easing: e.target.value });
								}}
							>
								<option value="smooth">Smooth</option>
								<option value="linear">Linear</option>
							</select>
						</label>
						<Button
							variant="outline"
							className="w-full"
							onClick={() => {
								if (!found) return;
								const start =
									target.edge === "exit"
										? found.element.startTime +
											found.element.duration -
											transition.duration
										: found.element.startTime;
								editor.playback.seek({ time: mediaTime({ ticks: start }) });
							}}
						>
							Go to transition
						</Button>
						<Button
							variant="ghost"
							className="w-full text-destructive"
							onClick={() => removeSelectedTransition(editor)}
						>
							Remove transition
						</Button>
						{target.edge === "cut" && (
							<p className="text-xs leading-relaxed text-muted-foreground">
								Reveals this clip over the previous clip’s unused tail. Trim the
								previous video’s end if more source footage is needed. Audio is
								unchanged.
							</p>
						)}
					</>
				) : (
					<>
						<p className="text-sm text-muted-foreground">
							Choose a card in the Transitions library to add{" "}
							{target.edge === "cut"
								? "a transition at this cut"
								: "an animation"}
							.
						</p>
						<Button
							variant="outline"
							onClick={() =>
								useAssetsPanelStore.getState().setActiveTab("transitions")
							}
						>
							Browse transitions
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
