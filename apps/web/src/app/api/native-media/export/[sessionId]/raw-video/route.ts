import { join } from "node:path";
import { requireExportSession } from "@/server/native-media/export-session";
import {
	appendMediaEngineStream,
	cancelMediaEngineStream,
	finishMediaEngineStream,
	requireLocalNativeRequest,
	startMediaEngineStream,
} from "@/server/native-media/engine";
import { nativeMediaError } from "@/server/native-media/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { sessionId } = await params;
		const directory = await requireExportSession(sessionId);
		const width = positiveIntegerHeader({
			request,
			name: "x-opencut-width",
		});
		const height = positiveIntegerHeader({
			request,
			name: "x-opencut-height",
		});
		const fpsNumerator = positiveIntegerHeader({
			request,
			name: "x-opencut-fps-numerator",
		});
		const fpsDenominator = positiveIntegerHeader({
			request,
			name: "x-opencut-fps-denominator",
		});
		const bitrate = positiveIntegerHeader({
			request,
			name: "x-opencut-video-bitrate",
		});
		const bitrateMode = request.headers.get("x-opencut-bitrate-mode");
		if (!(bitrateMode === "variable" || bitrateMode === "constant")) {
			throw new Error("x-opencut-bitrate-mode must be variable or constant");
		}
		await startMediaEngineStream({
			key: sessionId,
			args: [
				"encode-raw-video",
				"--output",
				join(directory, "video.mp4"),
				"--width",
				String(width),
				"--height",
				String(height),
				"--fps-numerator",
				String(fpsNumerator),
				"--fps-denominator",
				String(fpsDenominator),
				"--bitrate",
				String(bitrate),
				"--bitrate-mode",
				bitrateMode,
			],
		});
		return new Response(null, { status: 204 });
	} catch (error) {
		return nativeMediaError(error);
	}
}

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { sessionId } = await params;
		await requireExportSession(sessionId);
		await appendMediaEngineStream({ key: sessionId, body: request.body });
		return new Response(null, { status: 204 });
	} catch (error) {
		return nativeMediaError(error);
	}
}

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { sessionId } = await params;
		await requireExportSession(sessionId);
		await finishMediaEngineStream({ key: sessionId });
		return new Response(null, { status: 204 });
	} catch (error) {
		return nativeMediaError(error);
	}
}

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	try {
		requireLocalNativeRequest(request);
		const { sessionId } = await params;
		await cancelMediaEngineStream({ key: sessionId });
		return new Response(null, { status: 204 });
	} catch (error) {
		return nativeMediaError(error);
	}
}

function positiveIntegerHeader({
	request,
	name,
}: {
	request: Request;
	name: string;
}): number {
	const value = Number(request.headers.get(name));
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}
