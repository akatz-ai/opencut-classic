import { writeVideoChunk } from "@/server/native-media/export-session";
import { nativeMediaError } from "@/server/native-media/responses";
import { requireLocalNativeRequest } from "@/server/native-media/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { sessionId } = await params;
		const offset = Number(request.headers.get("x-opencut-offset"));
		await writeVideoChunk({ sessionId, offset, body: request.body });
		return new Response(null, { status: 204 });
	} catch (error) {
		return nativeMediaError(error);
	}
}
