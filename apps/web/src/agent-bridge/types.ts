import type { SceneTracks } from "@/timeline";

export type AgentCommandKind =
	| "stage_media"
	| "apply_cut_plan"
	| "export_project";

export interface AgentProjectSnapshot {
	revision: string;
	capturedAt: string;
	project: {
		id: string;
		name: string;
		durationSeconds: number;
		fps: number;
		canvasSize: { width: number; height: number };
	};
	activeScene: {
		id: string;
		name: string;
		tracks: SceneTracks;
	};
	media: Array<{
		id: string;
		name: string;
		type: string;
		sizeBytes: number;
		durationSeconds?: number;
		width?: number;
		height?: number;
		fps?: number;
		hasAudio?: boolean;
		codec?: string;
		proxyState?: string;
	}>;
	playheadSeconds: number;
}

export interface AgentBridgeCommand {
	id: string;
	projectId: string;
	kind: AgentCommandKind;
	payload: Record<string, unknown>;
	expectedRevision?: string;
	createdAt: string;
	deliveredAt?: string;
}

export interface AgentBridgeCommandResult {
	commandId: string;
	success: boolean;
	completedAt: string;
	revision?: string;
	result?: Record<string, unknown>;
	error?: string;
}
