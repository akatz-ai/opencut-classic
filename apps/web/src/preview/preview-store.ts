import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isGuideId, type GuideId } from "@/guides";
import { DEFAULT_GRID_CONFIG } from "@/guides/grid";
import type { GridConfig } from "@/guides/types";
import type { PreviewResolutionMode } from "@/preview/adaptive-resolution";
import { isPreviewResolutionMode } from "@/preview/adaptive-resolution";

type PreviewOverlaysState = Record<string, boolean>;

interface PreviewState {
	activeGuide: GuideId | null;
	overlays: PreviewOverlaysState;
	gridConfig: GridConfig;
	resolutionMode: PreviewResolutionMode;
	toggleGuide: (guideId: GuideId) => void;
	setGridConfig: (config: Partial<GridConfig>) => void;
	setResolutionMode: (mode: PreviewResolutionMode) => void;
	setOverlayVisibility: ({
		overlayId,
		isVisible,
	}: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
	toggleOverlayVisibility: ({ overlayId }: { overlayId: string }) => void;
}

const DEFAULT_PREVIEW_OVERLAYS: PreviewOverlaysState = {};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getPersistedActiveGuide(state: unknown): GuideId | null {
	if (!isRecord(state)) return null;
	const layoutGuide = isRecord(state.layoutGuide) ? state.layoutGuide : undefined;
	const persistedGuide =
		state.activeGuide ?? layoutGuide?.platform ?? null;

	if (typeof persistedGuide !== "string") {
		return null;
	}

	return isGuideId(persistedGuide) ? persistedGuide : null;
}

function getPersistedGridConfig(state: unknown): GridConfig {
	if (!isRecord(state) || !isRecord(state.gridConfig)) {
		return DEFAULT_GRID_CONFIG;
	}
	return {
		rows:
			typeof state.gridConfig.rows === "number"
				? state.gridConfig.rows
				: DEFAULT_GRID_CONFIG.rows,
		cols:
			typeof state.gridConfig.cols === "number"
				? state.gridConfig.cols
				: DEFAULT_GRID_CONFIG.cols,
	};
}

function getPersistedResolutionMode(state: unknown): PreviewResolutionMode {
	if (!isRecord(state) || typeof state.resolutionMode !== "string") {
		return "auto";
	}
	return isPreviewResolutionMode(state.resolutionMode)
		? state.resolutionMode
		: "auto";
}

export const usePreviewStore = create<PreviewState>()(
	persist(
		(set) => ({
			activeGuide: null,
			overlays: DEFAULT_PREVIEW_OVERLAYS,
			gridConfig: DEFAULT_GRID_CONFIG,
			resolutionMode: "auto",
			toggleGuide: (guideId) => {
				set((state) => ({
					activeGuide: state.activeGuide === guideId ? null : guideId,
				}));
			},
			setGridConfig: (config) => {
				set((state) => ({
					gridConfig: { ...state.gridConfig, ...config },
				}));
			},
			setResolutionMode: (resolutionMode) => set({ resolutionMode }),
			setOverlayVisibility: ({ overlayId, isVisible }) => {
				set((state) => ({
					overlays: {
						...state.overlays,
						[overlayId]: isVisible,
					},
				}));
			},
			toggleOverlayVisibility: ({ overlayId }) => {
				set((state) => ({
					overlays: {
						...state.overlays,
						[overlayId]: !state.overlays[overlayId],
					},
				}));
			},
		}),
		{
			name: "preview-settings",
			version: 7,
			migrate: (persistedState) => {
				return {
					activeGuide: getPersistedActiveGuide(persistedState),
					overlays: DEFAULT_PREVIEW_OVERLAYS,
					gridConfig: getPersistedGridConfig(persistedState),
					resolutionMode: getPersistedResolutionMode(persistedState),
				};
			},
			partialize: (state) => ({
				activeGuide: state.activeGuide,
				overlays: state.overlays,
				gridConfig: state.gridConfig,
				resolutionMode: state.resolutionMode,
			}),
		},
	),
);
