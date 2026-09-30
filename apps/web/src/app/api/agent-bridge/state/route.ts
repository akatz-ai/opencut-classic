import type { AgentProjectSnapshot } from "@/agent-bridge/types";
import { presentAgentState } from "@/agent-bridge/inspect";
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
		const query = new URL(request.url).searchParams;
		const projectId = query.get("projectId");
		if (!projectId)
			return Response.json({
				projects: (await listAgentStates()).map((state) =>
					presentAgentState({ state }),
				),
			});
		const state = await readAgentState({
			projectId,
			sessionId: query.get("sessionId") ?? undefined,
		});
		return state
			? Response.json(presentAgentState({ state, query }))
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
