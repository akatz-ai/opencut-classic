"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampAudioFadeDuration } from "opencut-wasm";
import { useEditor } from "@/editor/use-editor";
import {
	getAudioFadeInDuration,
	getAudioFadeOutDuration,
} from "@/timeline/audio-fades";
import { getLinePosFromDb } from "@/timeline/audio-display";
import { getElementVolume } from "@/timeline/audio-state";
import type { AudioElement } from "@/timeline/types";
import {
	mediaTimeToSeconds,
	roundMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import { cn } from "@/utils/ui";

type FadeSide = "in" | "out";
const KEYBOARD_STEP_SECONDS = 0.05;
const TOOLTIP_OFFSET_PX = 10;

function fieldForSide(side: FadeSide) {
	return side === "in" ? "fadeInDuration" : "fadeOutDuration";
}

function durationForSide({
	element,
	side,
}: {
	element: AudioElement;
	side: FadeSide;
}): MediaTime {
	return side === "in"
		? getAudioFadeInDuration({ element })
		: getAudioFadeOutDuration({ element });
}

function formatFadeDuration(duration: MediaTime): string {
	const seconds = mediaTimeToSeconds({ time: duration });
	return `${seconds < 1 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
}

export function AudioFadeHandles({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}) {
	const editor = useEditor();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const activePointerRef = useRef<{
		id: number;
		side: FadeSide;
		start: MediaTime;
		last: MediaTime;
		startClientX: number;
		surfaceWidth: number;
	} | null>(null);
	const [draggingSide, setDraggingSide] = useState<FadeSide | null>(null);
	const [tooltip, setTooltip] = useState<{
		x: number;
		y: number;
		duration: MediaTime;
		side: FadeSide;
	} | null>(null);

	const fadeIn = getAudioFadeInDuration({ element });
	const fadeOut = getAudioFadeOutDuration({ element });
	const duration = Math.max(1, element.duration);
	const fadeInPercent = (fadeIn / duration) * 100;
	const fadeOutPercent = 100 - (fadeOut / duration) * 100;
	const lineTop = getLinePosFromDb({ db: getElementVolume({ element }) });

	const previewDuration = useCallback(
		(side: FadeSide, nextDuration: MediaTime) => {
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: { [fieldForSide(side)]: nextDuration },
					},
				],
			});
		},
		[editor, element.id, trackId],
	);

	const updateFromPointer = useCallback(
		(side: FadeSide, clientX: number, clientY: number) => {
			const active = activePointerRef.current;
			if (!active || active.surfaceWidth <= 0) return;
			const pointerDelta = clientX - active.startClientX;
			const durationDelta =
				(pointerDelta / active.surfaceWidth) * element.duration;
			const requested =
				active.start + (side === "in" ? durationDelta : -durationDelta);
			const next = roundMediaTime({
				time: clampAudioFadeDuration(element.duration, requested),
			});
			active.last = next;
			previewDuration(side, next);
			setTooltip({
				x: clientX + TOOLTIP_OFFSET_PX,
				y: clientY - TOOLTIP_OFFSET_PX,
				duration: next,
				side,
			});
		},
		[element.duration, previewDuration],
	);

	const finishDrag = useCallback(
		(shouldCommit: boolean) => {
			const active = activePointerRef.current;
			activePointerRef.current = null;
			setDraggingSide(null);
			setTooltip(null);
			if (shouldCommit && active?.last !== active?.start) {
				editor.timeline.commitPreview();
			} else {
				editor.timeline.discardPreview();
			}
		},
		[editor],
	);

	const handlePointerDown = useCallback(
		(side: FadeSide, event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			editor.selection.setSelectedElements({
				elements: [{ trackId, elementId: element.id }],
			});
			const current = durationForSide({ element, side });
			const surfaceWidth =
				surfaceRef.current?.getBoundingClientRect().width ?? 0;
			activePointerRef.current = {
				id: event.pointerId,
				side,
				start: current,
				last: current,
				startClientX: event.clientX,
				surfaceWidth,
			};
			setDraggingSide(side);
			event.currentTarget.setPointerCapture(event.pointerId);
			setTooltip({
				x: event.clientX + TOOLTIP_OFFSET_PX,
				y: event.clientY - TOOLTIP_OFFSET_PX,
				duration: current,
				side,
			});
		},
		[editor.selection, element, trackId],
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const active = activePointerRef.current;
			if (!active || active.id !== event.pointerId) return;
			event.preventDefault();
			event.stopPropagation();
			updateFromPointer(active.side, event.clientX, event.clientY);
		},
		[updateFromPointer],
	);

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (activePointerRef.current?.id !== event.pointerId) return;
			event.preventDefault();
			event.stopPropagation();
			finishDrag(true);
		},
		[finishDrag],
	);

	const handleKeyDown = useCallback(
		(side: FadeSide, event: React.KeyboardEvent<HTMLDivElement>) => {
			const current = durationForSide({ element, side });
			const step =
				(event.shiftKey ? 0.5 : KEYBOARD_STEP_SECONDS) * TICKS_PER_SECOND;
			let requested: number | null = null;
			if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
				requested = current - step;
			} else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
				requested = current + step;
			} else if (event.key === "Home") {
				requested = 0;
			} else if (event.key === "End") {
				requested = element.duration;
			}
			if (requested === null) return;
			event.preventDefault();
			event.stopPropagation();
			const next = roundMediaTime({
				time: clampAudioFadeDuration(element.duration, requested),
			});
			if (next === current) return;
			previewDuration(side, next);
			editor.timeline.commitPreview();
		},
		[editor.timeline, element, previewDuration],
	);

	const renderHandle = ({
		side,
		value,
		left,
	}: {
		side: FadeSide;
		value: MediaTime;
		left: number;
	}) => (
		<div
			key={side}
			role="slider"
			tabIndex={0}
			aria-label={side === "in" ? "Audio fade in" : "Audio fade out"}
			aria-valuemin={0}
			aria-valuemax={mediaTimeToSeconds({ time: element.duration })}
			aria-valuenow={mediaTimeToSeconds({ time: value })}
			aria-valuetext={formatFadeDuration(value)}
			data-audio-fade={side}
			className={cn(
				"pointer-events-auto absolute z-20 size-4 -translate-x-1/2 -translate-y-1/2 touch-none cursor-ew-resize rounded-full outline-none",
				"after:absolute after:left-1/2 after:top-1/2 after:size-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border after:border-white after:bg-[#8F5DBA] after:shadow-sm",
				"focus-visible:ring-2 focus-visible:ring-white/90",
				draggingSide === side && "after:bg-white",
			)}
			style={{
				left: `clamp(6px, ${left}%, calc(100% - 6px))`,
				top: `${lineTop}%`,
			}}
			title={`${side === "in" ? "Fade in" : "Fade out"}: ${formatFadeDuration(value)}`}
			onPointerDown={(event) => handlePointerDown(side, event)}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={(event) => {
				if (activePointerRef.current?.id === event.pointerId) finishDrag(false);
			}}
			onLostPointerCapture={() => {
				if (activePointerRef.current?.side === side) finishDrag(true);
			}}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => handleKeyDown(side, event)}
		/>
	);

	return (
		<div ref={surfaceRef} className="pointer-events-none absolute inset-0 z-10">
			<svg
				className="absolute inset-0 size-full overflow-visible"
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<path
					d={`M 0 100 L ${fadeInPercent} ${lineTop} M ${fadeOutPercent} ${lineTop} L 100 100`}
					fill="none"
					stroke="rgba(255,255,255,0.8)"
					strokeWidth="1.2"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			{renderHandle({ side: "in", value: fadeIn, left: fadeInPercent })}
			{renderHandle({ side: "out", value: fadeOut, left: fadeOutPercent })}
			{tooltip &&
				createPortal(
					<div
						className="pointer-events-none fixed left-0 top-0 z-50 -translate-y-full rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white whitespace-nowrap"
						style={{
							transform: `translate(${tooltip.x}px, ${tooltip.y}px)`,
						}}
					>
						{tooltip.side === "in" ? "Fade in" : "Fade out"}:{" "}
						{formatFadeDuration(tooltip.duration)}
					</div>,
					document.body,
				)}
		</div>
	);
}
