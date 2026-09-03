import { createExportSession } from "@/server/native-media/export-session";
import { nativeMediaError } from "@/server/native-media/responses";
import {
	requireLocalNativeRequest,
	resolveMediaEngineBinary,
} from "@/server/native-media/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	try {
		requireLocalNativeRequest(request);
		await resolveMediaEngineBinary();
		return Response.json({ sessionId: await createExportSession() });
	} catch (error) {
		return nativeMediaError(error);
	}
}
