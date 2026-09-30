import type { AgentCommandKind } from "@/agent-bridge/types";
import { requireLocalNativeRequest } from "@/server/native-media/engine";
import {
	queueAgentCommand,
	takeAgentCommand,
} from "@/server/agent-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	try {
		requireLocalNativeRequest(request);
		const projectId = new URL(request.url).searchParams.get("projectId");
		if (!projectId) throw new Error("projectId is required");
		const sessionId =
			new URL(request.url).searchParams.get("sessionId") ?? undefined;
		return Response.json({
			command: await takeAgentCommand({ projectId, sessionId }),
		});
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent command error" },
			{ status: 400 },
		);
	}
}

export async function POST(request: Request) {
	try {
		requireLocalNativeRequest(request);
		const body: {
			projectId: string;
			kind: AgentCommandKind;
			payload?: Record<string, unknown>;
			expectedRevision?: string;
			sessionId?: string;
			idempotencyKey?: string;
		} = await request.json();
		if (
			!(
				body.kind === "stage_media" ||
				body.kind === "edit_batch" ||
				body.kind === "catalog" ||
				body.kind === "apply_cut_plan" ||
				body.kind === "export_project"
			)
		) {
			throw new Error("Unsupported agent command");
		}
		return Response.json({
			command: await queueAgentCommand({
				projectId: body.projectId,
				kind: body.kind,
				payload: body.payload ?? {},
				expectedRevision: body.expectedRevision,
				sessionId: body.sessionId,
				idempotencyKey: body.idempotencyKey,
			}),
		});
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent command error" },
			{ status: 400 },
		);
	}
}
