import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { colorAdjustEffectDefinition } from "./color-adjust";

const defaultEffects = [colorAdjustEffectDefinition, blurEffectDefinition];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
