import { requireLocalNativeRequest } from "@/server/native-media/engine";
import { saveAgentArtifact } from "@/server/agent-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
	try {
		requireLocalNativeRequest(request);
		if (!request.body) throw new Error("Artifact body is missing");
		const params = new URL(request.url).searchParams;
		const projectId = params.get("projectId");
		const mediaId = params.get("mediaId");
		const filename = params.get("filename");
		if (!projectId || !mediaId || !filename) {
			throw new Error("projectId, mediaId, and filename are required");
		}
		return Response.json(
			await saveAgentArtifact({
				projectId,
				mediaId,
				filename,
				body: request.body,
			}),
		);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Agent artifact error" },
			{ status: 400 },
		);
	}
}
