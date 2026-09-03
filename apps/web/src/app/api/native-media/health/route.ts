import { nativeMediaError } from "@/server/native-media/responses";
import {
	requireLocalNativeRequest,
	runMediaEngine,
} from "@/server/native-media/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	try {
		requireLocalNativeRequest(request);
		const output = await runMediaEngine({ args: ["health"] });
		return new Response(output, {
			headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
		});
	} catch (error) {
		return nativeMediaError(error);
	}
}
