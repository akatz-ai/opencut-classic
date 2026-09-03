import { join } from "node:path";
import {
	createNativeWorkspace,
	removeNativeWorkspace,
	requireLocalNativeRequest,
	runMediaEngine,
	safeSourceExtension,
	writeRequestBody,
} from "@/server/native-media/engine";
import { fileResponse, nativeMediaError } from "@/server/native-media/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
	const workspace = await createNativeWorkspace({ prefix: "proxy" });
	try {
		requireLocalNativeRequest(request);
		const extension = safeSourceExtension(
			request.headers.get("x-opencut-filename"),
		);
		const input = join(workspace, `source${extension}`);
		const output = join(workspace, "proxy.mp4");
		await writeRequestBody({ request, path: input });
		const metadata = await runMediaEngine({
			args: [
				"proxy",
				"--input",
				input,
				"--output",
				output,
				"--max-width",
				"1280",
				"--max-height",
				"720",
				"--max-fps",
				"30",
			],
		});
		return await fileResponse({
			path: output,
			contentType: "video/mp4",
			filename: "preview-proxy.mp4",
			headers: {
				"X-OpenCut-Proxy-Metadata": encodeURIComponent(metadata),
			},
			onComplete: () => removeNativeWorkspace(workspace),
		});
	} catch (error) {
		await removeNativeWorkspace(workspace);
		return nativeMediaError(error);
	}
}
