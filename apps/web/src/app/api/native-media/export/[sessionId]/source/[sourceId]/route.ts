import { writeAudioSource } from "@/server/native-media/export-session";
import { nativeMediaError } from "@/server/native-media/responses";
import { requireLocalNativeRequest } from "@/server/native-media/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function PUT(
	request: Request,
	{
		params,
	}: {
		params: Promise<{ sessionId: string; sourceId: string }>;
	},
) {
	try {
		requireLocalNativeRequest(request);
		const { sessionId, sourceId } = await params;
		await writeAudioSource({ sessionId, sourceId, body: request.body });
		return new Response(null, { status: 204 });
	} catch (error) {
		return nativeMediaError(error);
	}
}
