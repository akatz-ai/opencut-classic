"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Input } from "@/components/ui/input";
import { mediaTimeFromSeconds } from "@/wasm";
import { cn } from "@/utils/ui";
import { TRANSITION_MIME, TRANSITION_PRESETS } from "./catalog";
import { TransitionPreview } from "./transition-preview";
import {
	selectTransition,
	updateTransition,
	useSelectedTransition,
	useTransitionSelectionStore,
	type MotionEdge,
} from "./transition-selection";
import type { TransitionKind } from "./types";

export function TransitionsView() {
	const editor = useEditor();
	const selected = useEditor((e) => e.selection.getSelectedElements());
	const target = useSelectedTransition();
	const [edge, setEdge] = useState<MotionEdge>("cut");
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("All");
	const [hover, setHover] = useState<TransitionKind | null>(null);
	const activeEdge = target?.edge ?? edge;
	const found = target
		? editor.timeline.getElementsWithTracks({ elements: [target] })[0]
		: null;
	const activeKind =
		found?.element.motion?.[activeEdge === "exit" ? "exit" : "enter"]?.kind;
	function apply(kind: TransitionKind) {
		try {
			if (selected.length !== 1)
				throw new Error(
					"Select a cut on the timeline, or drag a card between two clips.",
				);
			const nextTarget = target ?? { ...selected[0], edge: activeEdge };
			const current = editor.timeline.getElementsWithTracks({
				elements: [nextTarget],
			})[0]?.element.motion?.[activeEdge === "exit" ? "exit" : "enter"];
			updateTransition({
				editor,
				target: nextTarget,
				transition: {
					kind,
					duration: current?.duration ?? mediaTimeFromSeconds({ seconds: 0.4 }),
					easing: current?.easing ?? "smooth",
				},
			});
			selectTransition({ editor, target: nextTarget });
		} catch (error) {
			toast.error(String(error instanceof Error ? error.message : error));
		}
	}
	const presets = TRANSITION_PRESETS.filter(
		(p) =>
			(category === "All" || p.category === category) &&
			p.label.toLowerCase().includes(search.toLowerCase().trim()),
	);
	return (
		<PanelView title="Transitions">
			<div className="space-y-3 pb-3">
				<div
					className="flex gap-1 rounded-md bg-muted/40 p-1 text-xs"
					role="tablist"
					aria-label="Transition placement"
				>
					{(
						[
							["cut", "Between clips"],
							["enter", "In"],
							["exit", "Out"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={activeEdge === value}
							className={cn(
								"rounded px-3 py-1.5",
								value === "cut" && "flex-1",
								activeEdge === value
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
							onClick={() => {
								setEdge(value);
								useTransitionSelectionStore.setState({
									target: null,
									selection: null,
								});
							}}
						>
							{label}
						</button>
					))}
				</div>
				<Input
					aria-label="Search transitions"
					placeholder="Search transitions"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="h-8"
				/>
				<div
					className="flex flex-wrap gap-1"
					aria-label="Transition categories"
				>
					{["All", "Basic", "Slide", "Zoom"].map((value) => (
						<button
							type="button"
							key={value}
							aria-pressed={category === value}
							onClick={() => setCategory(value)}
							className={cn(
								"rounded-full px-2.5 py-1 text-xs",
								category === value
									? "bg-primary/15 text-primary"
									: "text-muted-foreground hover:bg-muted",
							)}
						>
							{value}
						</button>
					))}
				</div>
				<div
					className="grid gap-x-2 gap-y-3"
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
					}}
				>
					{presets.map(({ kind, label }) => (
						<button
							key={kind}
							type="button"
							aria-label={`Apply ${label}`}
							aria-pressed={activeKind === kind}
							draggable={activeEdge === "cut"}
							onDragStart={(event) => {
								event.dataTransfer.setData(TRANSITION_MIME, kind);
								event.dataTransfer.effectAllowed = "copy";
							}}
							onClick={() => apply(kind)}
							onMouseEnter={() => setHover(kind)}
							onMouseLeave={() => setHover(null)}
							onFocus={() => setHover(kind)}
							onBlur={() => setHover(null)}
							className="group min-w-0 text-left outline-none"
						>
							<div
								className={cn(
									"relative aspect-[10/7] overflow-hidden rounded-md border-2 transition-colors group-focus-visible:border-primary group-hover:border-primary",
									activeKind === kind ? "border-primary" : "border-transparent",
								)}
							>
								<TransitionPreview
									kind={kind}
									playing={hover === kind}
									exit={activeEdge === "exit"}
								/>
								<span
									className="absolute right-1 bottom-1 flex size-6 items-center justify-center rounded bg-black/70 text-lg text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
									aria-hidden="true"
								>
									+
								</span>
							</div>
							<span className="mt-1 block truncate px-0.5 text-xs">
								{label}
							</span>
						</button>
					))}
				</div>
				{!presets.length && (
					<p className="py-6 text-center text-xs text-muted-foreground">
						No matching transitions.
					</p>
				)}
				<p className="text-xs leading-relaxed text-muted-foreground">
					{activeEdge === "cut"
						? "Drag to a cut, or select the incoming clip and click +. Select the transition on the timeline to adjust it."
						: `Select a visual clip, then choose an ${activeEdge === "enter" ? "entrance" : "exit"} animation.`}
				</p>
			</div>
		</PanelView>
	);
}
