import { describe, expect, test } from "bun:test";
import {
	buildDefaultEffectInstance,
	registerDefaultEffects,
	resolveEffectPasses,
} from "@/effects";
import { colorAdjustEffectDefinition as definition } from "./color-adjust";
import { getPropertiesConfig } from "@/components/editor/panels/properties/registry";
import { buildTextElement } from "@/timeline/element-utils";
import { ZERO_MEDIA_TIME } from "@/wasm";

describe("color adjustment", () => {
	test("is registered with neutral defaults", () => {
		registerDefaultEffects();
		const effect = buildDefaultEffectInstance({ effectType: "color-adjust" });
		expect(effect.enabled).toBe(true);
		expect(effect.params).toEqual({
			exposure: 0,
			contrast: 0,
			saturation: 100,
			temperature: 0,
			tint: 0,
		});
	});
	test("partial project parameters get neutral defaults", () => {
		const [pass] = resolveEffectPasses({
			definition,
			effectParams: { exposure: 1 },
			width: 640,
			height: 360,
		});
		expect(pass).toEqual({
			shader: "color-adjust",
			uniforms: {
				u_exposure: 1,
				u_contrast: 0,
				u_saturation: 100,
				u_temperature: 0,
				u_tint: 0,
			},
		});
	});
	test("preview and export sizes resolve the same color parameters", () => {
		const effectParams = {
			exposure: -1.25,
			contrast: 25,
			saturation: 0,
			temperature: 50,
			tint: -20,
		};
		expect(
			resolveEffectPasses({
				definition,
				effectParams,
				width: 640,
				height: 360,
			}),
		).toEqual(
			resolveEffectPasses({
				definition,
				effectParams,
				width: 3840,
				height: 2160,
			}),
		);
	});
	test("text has an Effects inspector for applied effects", () => {
		const element = {
			...buildTextElement({ startTime: ZERO_MEDIA_TIME, raw: {} }),
			id: "text",
		};
		expect(
			getPropertiesConfig({ element, mediaAssets: [] }).tabs.map(
				(tab) => tab.id,
			),
		).toContain("effects");
	});
});
