import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	requireExportSession,
	sourcePath,
} from "@/server/native-media/export-session";
import {
	requireLocalNativeRequest,
	runMediaEngine,
} from "@/server/native-media/engine";
import { fileResponse, nativeMediaError } from "@/server/native-media/responses";
import { removeExportSession } from "@/server/native-media/export-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const clipSchema = z.object({
	sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
	startTime: z.number().finite().nonnegative(),
	duration: z.number().finite().positive(),
	trimStart: z.number().finite().nonnegative(),
	rate: z.number().finite().min(0.01).max(100),
	maintainPitch: z.boolean(),
	volume: z.number().finite().nonnegative(),
});

const exportSchema = z.object({
	durationSeconds: z.number().finite().positive(),
	sampleRate: z.number().int().min(8000).max(192000).default(48000),
	clips: z.array(clipSchema),
});

// Next.js route handlers require this positional signature.
// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	let sessionId: string | null = null;
	try {
		requireLocalNativeRequest(request);
		const routeSessionId = (await params).sessionId;
		sessionId = routeSessionId;
		const directory = await requireExportSession(routeSessionId);
		const browserSpec = exportSchema.parse(await request.json());
		const spec = {
			durationSeconds: browserSpec.durationSeconds,
			sampleRate: browserSpec.sampleRate,
			clips: browserSpec.clips.map(({ sourceId, ...clip }) => ({
				...clip,
				source: sourcePath({ sessionId: routeSessionId, sourceId }),
			})),
		};
		const specPath = join(directory, "audio-spec.json");
		const videoPath = join(directory, "video.mp4");
		const outputPath = join(directory, "export.mp4");
		await writeFile(specPath, JSON.stringify(spec));
		await runMediaEngine({
			args: [
				"mux-export",
				"--video",
				videoPath,
				"--spec",
				specPath,
				"--output",
				outputPath,
			],
		});
		return await fileResponse({
			path: outputPath,
			contentType: "video/mp4",
			filename: "opencut-export.mp4",
			onComplete: () => removeExportSession(routeSessionId),
		});
	} catch (error) {
		if (sessionId) await removeExportSession(sessionId);
		return nativeMediaError(error);
	}
}
