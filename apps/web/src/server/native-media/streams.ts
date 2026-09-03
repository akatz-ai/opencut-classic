export async function* readWebStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}
