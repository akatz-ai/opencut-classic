"use client";

import { useEffect, useState } from "react";
import { evaluateMotion } from "opencut-wasm";
import type { TransitionKind } from "./types";

/** Original vector scenes animated by the same evaluator as the export. */
export function TransitionPreview({
	kind,
	playing = false,
	exit = false,
}: {
	kind: TransitionKind;
	playing?: boolean;
	exit?: boolean;
}) {
	const [progress, setProgress] = useState(0.48);
	useEffect(() => {
		if (
			!playing ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		)
			return;
		let frame = 0;
		const start = performance.now();
		function tick(now: number) {
			setProgress(
				Math.min(1, Math.max(0, (((now - start) % 1800) - 250) / 1000)),
			);
			frame = requestAnimationFrame(tick);
		}
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing]);
	const delta = evaluateMotion(
		{ [exit ? "exit" : "enter"]: { kind, duration: 1, easing: "smooth" } },
		playing ? progress : 0.48,
		1,
	);
	return (
		<svg viewBox="0 0 160 112" className="size-full" aria-hidden="true">
			<rect width="160" height="112" fill="#172541" />
			<circle cx="121" cy="28" r="14" fill="#ffbe70" />
			<path d="M0 88 42 35 86 86 117 52 160 95V112H0Z" fill="#5366a8" />
			<path d="m24 59 18-24 21 25-20-8Z" fill="#d4d8ef" />
			<path d="M0 93Q45 73 91 95T160 90V112H0Z" fill="#ff7b8d" />
			<text x="10" y="22" fill="white" fontSize="13" fontWeight="700">
				A
			</text>
			<g
				opacity={delta.opacity}
				transform={`translate(${80 + delta.x * 160} ${56 + delta.y * 112}) scale(${delta.scale}) translate(-80 -56)`}
			>
				<rect width="160" height="112" fill="#064a59" />
				<circle cx="120" cy="29" r="16" fill="#70f2da" />
				<path d="M0 78Q36 51 77 79T160 69V112H0Z" fill="#048e9b" />
				<path d="M0 97Q43 74 92 95T160 87V112H0Z" fill="#1dc6cf" />
				<path d="m70 73 16-37 15 37Z" fill="#ecf8ff" />
				<path d="M64 76h43l-10 8H73Z" fill="#111d35" />
				<text x="10" y="22" fill="white" fontSize="13" fontWeight="700">
					B
				</text>
			</g>
		</svg>
	);
}
