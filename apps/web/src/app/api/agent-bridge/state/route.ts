import type { AgentProjectSnapshot } from "@/agent-bridge/types";
import { requireLocalNativeRequest } from "@/server/native-media/engine";
import {
	listAgentStates,
	readAgentState,
	saveAgentState,
} from "@/server/agent-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	try {
		requireLocalNativeRequest(request);
		const projectId = new URL(request.url).searchParams.get("projectId");
		if (!projectId) return Response.json({ projects: await listAgentStates() });
		const state = await readAgentState({ projectId });
		return state
			? Response.json(state)
			: Response.json({ error: "Project bridge is offline" }, { status: 404 });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent state error" },
			{ status: 400 },
		);
	}
}

export async function POST(request: Request) {
	try {
		requireLocalNativeRequest(request);
		const snapshot: AgentProjectSnapshot = await request.json();
		await saveAgentState(snapshot);
		return new Response(null, { status: 204 });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent state error" },
			{ status: 400 },
		);
	}
}
