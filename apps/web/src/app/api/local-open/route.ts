import { Readable } from "node:stream";
import {
	completeLocalOpenTicket,
	openTicketVideo,
	readLocalOpenTicket,
	requireLocalOpenRequest,
} from "@/server/local-open/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	try {
		requireLocalOpenRequest(request);
		if (!request.headers.get("content-type")?.startsWith("application/json"))
			throw new Error("JSON required");
		const { ticket: id, action } = await request.json();
		if (
			typeof id !== "string" ||
			!["inspect", "read", "complete"].includes(action)
		)
			throw new Error("Invalid request");
		const ticket = await readLocalOpenTicket(id);
		const headers = {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		};
		if (action === "complete") {
			await completeLocalOpenTicket(id);
			return Response.json({ ok: true }, { headers });
		}
		const file = await openTicketVideo(ticket);
		if (action === "inspect") {
			await file.close();
			return Response.json(
				{
					name: ticket.name,
					mime: ticket.mime,
					size: ticket.size,
					lastModified: ticket.mtimeMs,
				},
				{ headers },
			);
		}
		// Node and DOM declare incompatible BYOB overloads for the same web stream.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const stream = Readable.toWeb(
			file.createReadStream({ autoClose: true }),
		) as unknown as ReadableStream<Uint8Array>;
		return new Response(stream, {
			headers: {
				...headers,
				"Content-Type": ticket.mime,
				"Content-Length": String(ticket.size),
			},
		});
	} catch {
		// Do not reveal local paths or ticket existence to arbitrary callers.
		return Response.json(
			{
				error:
					"This local import is unavailable, expired, or the file changed. Open the video from Dolphin again.",
			},
			{ status: 400, headers: { "Cache-Control": "no-store" } },
		);
	}
}
