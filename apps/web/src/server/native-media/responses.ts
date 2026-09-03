import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function fileResponse({
	path,
	contentType,
	filename,
	headers,
	onComplete,
}: {
	path: string;
	contentType: string;
	filename: string;
	headers?: HeadersInit;
	onComplete: () => Promise<void>;
}): Promise<Response> {
	const fileStat = await stat(path);
	const nodeStream = createReadStream(path);
	const iterator = nodeStream[Symbol.asyncIterator]();
	let completed = false;
	const complete = async () => {
		if (completed) return;
		completed = true;
		await onComplete();
	};
	const body = new ReadableStream<Uint8Array>({
		pull: async (controller) => {
			try {
				const { value, done } = await iterator.next();
				if (done) {
					controller.close();
					await complete();
					return;
				}
				controller.enqueue(new Uint8Array(value));
			} catch (error) {
				controller.error(error);
				await complete();
			}
		},
		cancel: async () => {
			nodeStream.destroy();
			await complete();
		},
	});

	return new Response(body, {
		headers: {
			"Content-Type": contentType,
			"Content-Length": String(fileStat.size),
			"Content-Disposition": `attachment; filename="${filename.replaceAll('"', "")}"`,
			"Cache-Control": "no-store",
			...headers,
		},
	});
}

export function nativeMediaError(error: unknown): Response {
	const message = error instanceof Error ? error.message : "Native media error";
	console.error("[native-media]", message);
	return Response.json({ error: message }, { status: 503 });
}
