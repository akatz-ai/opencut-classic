"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Input } from "@/components/ui/input";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { initializeGpuRenderer } from "@/services/renderer/gpu-renderer";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement, isVisualElement } from "@/timeline/element-utils";
import { BatchCommand } from "@/commands/batch-command";
import { AddClipEffectCommand } from "@/commands/timeline/element/effects/add-effect";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useTransitionSelectionStore } from "@/motion/transition-selection";
import { cn } from "@/utils/ui";

export function EffectsView({
	initialSearch = "",
	title = "Effects",
}: {
	initialSearch?: string;
	title?: string;
}) {
	const editor = useEditor();
	const selected = useEditor((e) => e.selection.getSelectedElements());
	useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const [search, setSearch] = useState(initialSearch);
	const [placement, setPlacement] = useState<"clips" | "layer">("clips");
	const [message, setMessage] = useState("");
	const targets = editor.timeline
		.getElementsWithTracks({ elements: selected })
		.filter(({ element }) => isVisualElement(element));
	const effects = effectsRegistry
		.getAll()
		.filter((effect) =>
			[effect.name, ...effect.keywords]
				.join(" ")
				.toLowerCase()
				.includes(search.trim().toLowerCase()),
		);

	function apply(effectType: string) {
		useTransitionSelectionStore.setState({ target: null, selection: null });
		if (placement === "clips") {
			if (!targets.length) return;
			editor.command.execute({
				command: new BatchCommand(
					targets.map(
						({ track, element }) =>
							new AddClipEffectCommand({
								trackId: track.id,
								elementId: element.id,
								effectType,
							}),
					),
				),
			});
			for (const { element } of targets) {
				usePropertiesStore
					.getState()
					.setActiveTab({ elementType: element.type, tabId: "effects" });
			}
			setMessage(
				`Applied to ${targets.length} visual ${targets.length === 1 ? "clip" : "clips"}. Undo removes this addition.`,
			);
		} else {
			editor.timeline.insertElement({
				placement: { mode: "auto", trackType: "effect", insertIndex: 0 },
				element: {
					...buildEffectElement({
						effectType,
						startTime: editor.playback.getCurrentTime(),
					}),
					name: effectsRegistry.get(effectType).name,
				},
			});
			setMessage(
				"Added an adjustment layer at the playhead. Trim it to the range you want.",
			);
		}
	}

	return (
		<PanelView title={title}>
			<div className="space-y-3 pb-3">
				<Input
					aria-label="Search effects"
					placeholder="Search effects…"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<div
					className="flex gap-1 rounded-md bg-muted/40 p-1"
					role="group"
					aria-label="Effect placement"
				>
					{(
						[
							["clips", "Selected clips"],
							["layer", "Adjustment layer"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							data-native-button=""
							type="button"
							aria-pressed={placement === value}
							className={cn(
								"flex-1 rounded px-2 py-1.5 text-xs focus-visible:outline focus-visible:outline-primary",
								placement === value
									? "bg-muted text-foreground"
									: "text-muted-foreground",
							)}
							onClick={() => {
								setPlacement(value);
								setMessage("");
							}}
						>
							{label}
						</button>
					))}
				</div>
				<p className="text-xs text-muted-foreground">
					{placement === "clips"
						? targets.length
							? `${targets.length} visual ${targets.length === 1 ? "clip" : "clips"} selected. Click a card to apply.`
							: "Select a visual clip, then click a card. Or drag a card directly onto a clip."
						: "Adds a timed effect above your footage, affecting all layers underneath it."}
				</p>
				<div className="grid grid-cols-2 gap-2">
					{effects.map((effect) => (
						<button
							key={effect.type}
							data-native-button=""
							type="button"
							draggable
							aria-label={`Add ${effect.name}`}
							aria-disabled={placement === "clips" && targets.length === 0}
							className="group overflow-hidden rounded-md border border-border text-left hover:border-primary/60 focus-visible:outline focus-visible:outline-primary"
							onClick={() => apply(effect.type)}
							onDragStart={(event) =>
								editor.timeline.dragSource.begin({
									dataTransfer: event.dataTransfer,
									dragData: {
										id: effect.type,
										name: effect.name,
										type: "effect",
										effectType: effect.type,
										targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
									},
								})
							}
							onDragEnd={() => editor.timeline.dragSource.end()}
						>
							<div className="relative aspect-square bg-muted">
								<EffectPreviewCanvas effectType={effect.type} />
								<Plus
									aria-hidden
									className="absolute bottom-2 right-2 size-5 rounded bg-background/80 p-0.5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
								/>
							</div>
							<span className="block px-2 py-2 text-xs">{effect.name}</span>
						</button>
					))}
				</div>
				{effects.length === 0 && (
					<p className="text-xs text-muted-foreground">No matching effects.</p>
				)}
				<p role="status" className="text-xs text-muted-foreground">
					{message}
				</p>
			</div>
		</PanelView>
	);
}

function EffectPreviewCanvas({ effectType }: { effectType: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		let disposed = false;
		const render = () => {
			if (!disposed && canvasRef.current)
				effectPreviewService.renderPreview({
					effectType,
					params: {},
					targetCanvas: canvasRef.current,
				});
		};
		const unsubscribe = effectPreviewService.onPreviewImageReady({
			callback: render,
		});
		void initializeGpuRenderer().then(render);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [effectType]);
	return <canvas ref={canvasRef} aria-hidden className="size-full" />;
}
