import type { ExportDestination, ExportResult } from "@/export";

export async function receiveNativeExport({
	stream,
	destination,
}: {
	stream: ReadableStream<Uint8Array>;
	destination?: ExportDestination;
}): Promise<ExportResult> {
	if (!destination) {
		return {
			success: true,
			savedToFile: false,
			buffer: await new Response(stream).arrayBuffer(),
		};
	}
	if (destination.writeResponse) {
		await destination.writeResponse(stream);
	} else {
		const writer = destination.writable.getWriter();
		const reader = stream.getReader();
		let position = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write({
					type: "write",
					position,
					data: new Uint8Array(value),
				});
				position += value.byteLength;
			}
			await writer.close();
		} catch (error) {
			await reader.cancel(error).catch(() => undefined);
			await writer.abort(error).catch(() => undefined);
			throw error;
		} finally {
			reader.releaseLock();
			writer.releaseLock();
		}
	}
	return { success: true, savedToFile: true };
}
