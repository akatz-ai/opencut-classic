"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BatchCommand } from "@/commands/batch-command";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import {
	buildGraphicElement,
	buildTextElement,
} from "@/timeline/element-utils";
import type { CreateTimelineElement } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	AKATZ_PALETTE,
	AKATZ_VECTORS,
	brandVectorSvg,
	type BrandVector,
} from "./definitions/akatz";

function VectorPreview({ vector }: { vector: BrandVector }) {
	return (
		<svg
			viewBox="0 0 512 512"
			role="img"
			aria-label={vector.name}
			className="h-20 w-full"
		>
			{vector.parts.map((p, i) => (
				<path
					key={`${vector.id}-${i}`}
					d={p.d}
					fill={vector[p.paint]}
					stroke={
						p.outline
							? vector.id === "akatz-card"
								? "#00E5FF"
								: "#050A0F"
							: "none"
					}
					strokeWidth={6}
					strokeLinejoin="round"
				/>
			))}
		</svg>
	);
}

export function BrandKitView() {
	const editor = useEditor();
	const [title, setTitle] = useState("HOW IT WORKS");
	const [description, setDescription] = useState(
		"Tools / Workflows / Experiments",
	);
	const [message, setMessage] = useState("");
	const start = () => editor.playback.getCurrentTime();
	function insert(elements: CreateTimelineElement[]) {
		editor.command.execute({
			command: new BatchCommand(
				elements.map(
					(element) =>
						new InsertElementCommand({
							element,
							placement: {
								mode: "auto",
								trackType: element.type === "text" ? "text" : "graphic",
								insertIndex: 0,
							},
						}),
				),
			),
		});
		setMessage(
			"Added at the playhead. Each layer is editable; Undo removes this insertion.",
		);
	}
	function addVector(vector: BrandVector) {
		insert([
			buildGraphicElement({
				definitionId: vector.id,
				startTime: start(),
				params: {
					"transform.scaleX": vector.scaleX,
					"transform.scaleY": vector.scaleY,
				},
			}),
		]);
	}
	function download(vector: BrandVector) {
		const url = URL.createObjectURL(
			new Blob([brandVectorSvg(vector)], { type: "image/svg+xml" }),
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${vector.id}.svg`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	function layout(comparison: boolean) {
		const time = start();
		const canvas = editor.project.getActive().settings.canvasSize;
		const unit = Math.min(canvas.width, canvas.height);
		const motion = {
			enter: {
				kind: "pop" as const,
				duration: mediaTimeFromSeconds({ seconds: 0.35 }),
				easing: "smooth" as const,
			},
			exit: {
				kind: "fade" as const,
				duration: mediaTimeFromSeconds({ seconds: 0.25 }),
				easing: "smooth" as const,
			},
		};
		const graphic = ({
			id,
			x,
			sx,
			sy,
		}: {
			id: string;
			x: number;
			sx: number;
			sy: number;
		}) => ({
			...buildGraphicElement({
				definitionId: id,
				startTime: time,
				params: {
					"transform.positionX": x,
					"transform.scaleX": sx,
					"transform.scaleY": sy,
				},
			}),
			motion,
		});
		const text = ({
			content,
			x,
			y,
			size,
			color,
		}: {
			content: string;
			x: number;
			y: number;
			size: number;
			color: string;
		}) => ({
			...buildTextElement({
				startTime: time,
				raw: {
					name: content,
					params: {
						content,
						fontFamily: "Arial",
						fontSize: size,
						fontWeight: "bold",
						color,
						"transform.positionX": x,
						"transform.positionY": y,
					},
				},
			}),
			motion,
		});
		if (comparison) {
			const offset = unit * 0.31;
			insert([
				graphic({ id: "akatz-card", x: -offset, sx: 0.46, sy: 0.34 }),
				graphic({ id: "akatz-card", x: offset, sx: 0.46, sy: 0.34 }),
				graphic({ id: "akatz-arrow", x: 0, sx: 0.15, sy: 0.15 }),
				text({
					content: "INPUT",
					x: -offset,
					y: 0,
					size: 3.5,
					color: "#F4F7FB",
				}),
				text({
					content: "RESULT",
					x: offset,
					y: 0,
					size: 3.5,
					color: "#00E5FF",
				}),
				text({
					content: title,
					x: 0,
					y: -unit * 0.3,
					size: 4,
					color: "#F4F7FB",
				}),
			]);
		} else {
			insert([
				graphic({ id: "akatz-card", x: 0, sx: 0.9, sy: 0.42 }),
				text({
					content: title,
					x: 0,
					y: -unit * 0.045,
					size: 4.5,
					color: "#F4F7FB",
				}),
				text({
					content: description,
					x: 0,
					y: unit * 0.075,
					size: 2.2,
					color: "#00E5FF",
				}),
			]);
		}
	}
	function applyColor(color: string) {
		const tracks = editor.scenes.getActiveScene().tracks;
		const updates = editor.selection.getSelectedElements().flatMap((ref) => {
			const element = [tracks.main, ...tracks.overlay]
				.find((t) => t.id === ref.trackId)
				?.elements.find((e) => e.id === ref.elementId);
			return element?.type === "graphic" || element?.type === "text"
				? [
						{
							...ref,
							patch: {
								params: {
									...element.params,
									[element.type === "text" ? "color" : "fill"]: color,
								},
							},
						},
					]
				: [];
		});
		editor.timeline.updateElements({ updates });
		setMessage(
			updates.length
				? "Applied brand color to the selected text/graphics."
				: "Select text or a graphic to apply its fill color.",
		);
	}
	return (
		<PanelView title="Akatz Labs · Brand Kit">
			<div className="space-y-4 p-2 text-sm">
				<p className="text-muted-foreground">
					Editable vector graphics inspired by your brand sheet. Click a graphic
					to add it; use SVG to download the vector artwork.
				</p>
				<div className="flex flex-wrap gap-2">
					{Object.entries(AKATZ_PALETTE).map(([name, color]) => (
						<button
							key={name}
							type="button"
							aria-label={`Apply ${name}`}
							title={`${name} ${color} · apply to selected fill`}
							className="size-7 rounded border"
							style={{ background: color }}
							onClick={() => applyColor(color)}
						/>
					))}
				</div>
				<div className="grid grid-cols-2 gap-2">
					{AKATZ_VECTORS.map((v) => (
						<div
							key={v.id}
							className="rounded border p-2"
							style={{ background: "#15263F" }}
						>
							<button
								type="button"
								className="w-full cursor-pointer text-white"
								onClick={() => addVector(v)}
								aria-label={`Add ${v.name}`}
							>
								<VectorPreview vector={v} />
								<span className="text-xs">{v.name}</span>
							</button>
							<Button
								variant="ghost"
								size="sm"
								className="mt-1 w-full text-xs text-white"
								onClick={() => download(v)}
							>
								SVG ↓
							</Button>
						</div>
					))}
				</div>
				<div className="space-y-2 border-t pt-3">
					<h3 className="font-medium">Editable layouts</h3>
					<label htmlFor="brand-heading" className="block space-y-1">
						Heading
						<Input
							id="brand-heading"
							aria-label="Brand heading"
							maxLength={40}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</label>
					<label htmlFor="brand-subtitle" className="block space-y-1">
						Subtitle
						<Input
							id="brand-subtitle"
							aria-label="Brand subtitle"
							maxLength={64}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
						/>
					</label>
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={() => layout(false)}>
							Explain card
						</Button>
						<Button variant="outline" onClick={() => layout(true)}>
							Input → Result
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						Five-second layouts with pop-in/fade-out motion. Text stays live and
						editable. These insert separate layers, not a nested composition.
						The scene pin is artwork only; tracking is not yet connected.
					</p>
				</div>
				{message && (
					<p role="status" className="rounded border p-2">
						{message}
					</p>
				)}
			</div>
		</PanelView>
	);
}
