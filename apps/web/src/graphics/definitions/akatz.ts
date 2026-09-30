import type { GraphicDefinition } from "../types";

export const AKATZ_PALETTE = {
	"Near black": "#050A0F",
	"Deep navy": "#081B2D",
	Slate: "#15263F",
	Cyan: "#00E5FF",
	"Electric blue": "#3B82FF",
	Magenta: "#FF209B",
	Amber: "#FFC857",
	"Off white": "#F4F7FB",
};
type VectorPart = { d: string; paint: "fill" | "accent"; outline?: boolean };
export type BrandVector = {
	id: string;
	name: string;
	fill: string;
	accent: string;
	parts: VectorPart[];
	scaleX: number;
	scaleY: number;
};
/** One geometry source for the native canvas renderer, UI SVG previews, and SVG downloads. */
export const AKATZ_VECTORS: BrandVector[] = [
	{
		id: "akatz-arrow",
		name: "Bold arrow",
		fill: "#00E5FF",
		accent: "#FF209B",
		scaleX: 0.55,
		scaleY: 0.55,
		parts: [
			{
				d: "M28 200 H300 V112 L490 256 300 400 V312 H28 Z",
				paint: "fill",
				outline: true,
			},
		],
	},
	{
		id: "akatz-curved-arrow",
		name: "Curved arrow",
		fill: "#00E5FF",
		accent: "#FF209B",
		scaleX: 0.55,
		scaleY: 0.55,
		parts: [
			{
				d: "M34 422 C34 208 160 142 330 154 L330 64 494 204 330 336 330 242 C200 232 124 266 122 422 Z",
				paint: "fill",
				outline: true,
			},
		],
	},
	{
		id: "akatz-chevrons",
		name: "Double chevron",
		fill: "#FF209B",
		accent: "#00E5FF",
		scaleX: 0.3,
		scaleY: 0.3,
		parts: [
			{
				d: "M28 112 H134 L264 256 134 400 H28 L158 256 Z M244 112 H350 L480 256 350 400 H244 L374 256 Z",
				paint: "fill",
				outline: true,
			},
		],
	},
	{
		id: "akatz-card",
		name: "Technical card",
		fill: "#081B2D",
		accent: "#00E5FF",
		scaleX: 0.9,
		scaleY: 0.45,
		parts: [
			{
				d: "M42 16 H430 L496 82 V470 L470 496 H16 V42 Z",
				paint: "fill",
				outline: true,
			},
			{
				d: "M42 36 H190 V49 H42 Z M442 436 H470 V470 H436 V458 H458 V436 Z",
				paint: "accent",
			},
		],
	},
	{
		id: "akatz-brackets",
		name: "Focus brackets",
		fill: "#FFC857",
		accent: "#00E5FF",
		scaleX: 0.45,
		scaleY: 0.45,
		parts: [
			{
				d: "M20 146 V20 H146 V42 H42 V146 Z M366 20 H492 V146 H470 V42 H366 Z M492 366 V492 H366 V470 H470 V366 Z M146 492 H20 V366 H42 V470 H146 Z",
				paint: "fill",
			},
		],
	},
	{
		id: "akatz-pin",
		name: "Scene pin",
		fill: "#FF209B",
		accent: "#F4F7FB",
		scaleX: 0.25,
		scaleY: 0.25,
		parts: [
			{
				d: "M256 492 L107 290 C17 166 103 20 256 20 C409 20 495 166 405 290 Z",
				paint: "fill",
				outline: true,
			},
			{
				d: "M324 182 A68 68 0 1 1 188 182 A68 68 0 1 1 324 182 Z",
				paint: "accent",
			},
		],
	},
];

export const akatzGraphicDefinitions: GraphicDefinition[] = AKATZ_VECTORS.map(
	(vector) => ({
		id: vector.id,
		name: `Akatz ${vector.name}`,
		keywords: ["akatz", "brand", "explain", vector.name],
		params: [
			{ key: "fill", label: "Fill", type: "color", default: vector.fill },
			{ key: "accent", label: "Accent", type: "color", default: vector.accent },
			{
				key: "stroke",
				label: "Outline",
				type: "color",
				default: vector.id === "akatz-card" ? "#00E5FF" : "#050A0F",
			},
			{
				key: "strokeWidth",
				label: "Outline width",
				type: "number",
				default: 6,
				min: 0,
				max: 24,
				step: 1,
			},
		],
		render({ ctx, params, width, height }) {
			ctx.clearRect(0, 0, width, height);
			ctx.save();
			ctx.scale(width / 512, height / 512);
			ctx.lineJoin = "round";
			const strokeWidth = Number(params.strokeWidth ?? 6);
			ctx.lineWidth = Math.max(0.01, strokeWidth);
			ctx.strokeStyle = String(params.stroke ?? "#050A0F");
			for (const part of vector.parts) {
				const path = new Path2D(part.d);
				ctx.fillStyle = String(params[part.paint] ?? vector[part.paint]);
				ctx.fill(path);
				if (part.outline && strokeWidth > 0) ctx.stroke(path);
			}
			ctx.restore();
		},
	}),
);

export function brandVectorSvg(vector: BrandVector): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><title>Akatz Labs — ${vector.name}</title>${vector.parts.map((p) => `<path d="${p.d}" fill="${vector[p.paint]}"${p.outline ? ` stroke="${vector.id === "akatz-card" ? "#00E5FF" : "#050A0F"}" stroke-width="6" stroke-linejoin="round"` : ""}/>`).join("")}</svg>`;
}
