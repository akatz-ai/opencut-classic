import type { EffectDefinition } from "@/effects/types";

export const colorAdjustEffectDefinition: EffectDefinition = {
	type: "color-adjust",
	name: "Color adjustment",
	keywords: [
		"color",
		"colour",
		"exposure",
		"contrast",
		"saturation",
		"temperature",
		"tint",
		"balance",
	],
	params: [
		{
			key: "exposure",
			label: "Exposure (stops)",
			type: "number",
			default: 0,
			min: -4,
			max: 4,
			step: 0.05,
		},
		{
			key: "contrast",
			label: "Contrast",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "saturation",
			label: "Saturation",
			type: "number",
			default: 100,
			min: 0,
			max: 200,
			step: 1,
		},
		{
			key: "temperature",
			label: "Temperature",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "tint",
			label: "Tint",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "color-adjust",
				uniforms: ({ effectParams }) => ({
					u_exposure: Number(effectParams.exposure ?? 0),
					u_contrast: Number(effectParams.contrast ?? 0),
					u_saturation: Number(effectParams.saturation ?? 100),
					u_temperature: Number(effectParams.temperature ?? 0),
					u_tint: Number(effectParams.tint ?? 0),
				}),
			},
		],
	},
};
