import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createNativeWorkspace,
	removeNativeWorkspace,
	requireLocalNativeRequest,
	runMediaEngine,
} from "@/server/native-media/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const workspace = await createNativeWorkspace({ prefix: "agent-cuts" });
	try {
		requireLocalNativeRequest(request);
		const body: unknown = await request.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("tracks" in body) ||
			!("ranges" in body) ||
			!Array.isArray(body.ranges)
		) {
			throw new Error("tracks and ranges are required");
		}
		const tracksPath = join(workspace, "tracks.json");
		const rangesPath = join(workspace, "ranges.json");
		await Promise.all([
			writeFile(tracksPath, JSON.stringify(body.tracks)),
			writeFile(rangesPath, JSON.stringify(body.ranges)),
		]);
		const output = await runMediaEngine({
			args: [
				"apply-cuts",
				"--tracks",
				tracksPath,
				"--ranges",
				rangesPath,
			],
		});
		return new Response(output, {
			headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
		});
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Cut planning failed" },
			{ status: 400 },
		);
	} finally {
		await removeNativeWorkspace(workspace);
	}
}
