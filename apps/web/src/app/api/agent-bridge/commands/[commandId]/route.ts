import type { AgentBridgeCommandResult } from "@/agent-bridge/types";
import { requireLocalNativeRequest } from "@/server/native-media/engine";
import {
	readAgentCommandResult,
	saveAgentCommandResult,
} from "@/server/agent-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ commandId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { commandId } = await params;
		const projectId = new URL(request.url).searchParams.get("projectId");
		if (!projectId) throw new Error("projectId is required");
		const result = await readAgentCommandResult({ projectId, commandId });
		return result
			? Response.json(result)
			: Response.json({ status: "pending" }, { status: 202 });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent result error" },
			{ status: 400 },
		);
	}
}

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ commandId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { commandId } = await params;
		const body: { projectId: string; result: AgentBridgeCommandResult } =
			await request.json();
		if (body.result.commandId !== commandId) {
			throw new Error("Command result ID mismatch");
		}
		await saveAgentCommandResult({
			projectId: body.projectId,
			result: body.result,
		});
		return new Response(null, { status: 204 });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent result error" },
			{ status: 400 },
		);
	}
}
