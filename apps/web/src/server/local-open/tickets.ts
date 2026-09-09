// Linux desktop handoff: only a file explicitly selected by the local launcher
// is readable. There is deliberately no HTTP endpoint that accepts a file path.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";

const TICKET_ID = /^[a-f0-9]{64}$/;
const TTL_MS = 30 * 60 * 1000;
const MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mpg": "video/mpeg",
	".mpeg": "video/mpeg",
	".ogv": "video/ogg",
	".ts": "video/mp2t",
	".mts": "video/mp2t",
	".m2ts": "video/mp2t",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
};

const TicketSchema = z.object({
	version: z.literal(1),
	path: z.string(),
	name: z.string(),
	mime: z.string(),
	size: z.number().positive(),
	mtimeMs: z.number(),
	ino: z.number(),
	dev: z.number(),
	expiresAt: z.number(),
});
type Ticket = z.infer<typeof TicketSchema>;

export function ticketRoot(): string {
	return (
		process.env.OPENCUT_LOCAL_OPEN_DIR ??
		join(homedir(), ".local/state/opencut/local-open")
	);
}

async function privateRoot(): Promise<string> {
	const root = ticketRoot();
	await mkdir(root, { recursive: true, mode: 0o700 });
	const st = await lstat(root);
	if (
		!st.isDirectory() ||
		st.isSymbolicLink() ||
		(st.mode & 0o077) !== 0 ||
		st.uid !== process.getuid?.()
	) {
		throw new Error("Local import directory must be private to this user");
	}
	return root;
}

export async function createLocalOpenTicket(file: string): Promise<string> {
	const path = await realpath(file);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const st = await handle.stat();
		const mime = MIME_TYPES[extname(path).toLowerCase()];
		if (!st.isFile() || !mime || st.size === 0)
			throw new Error("Select a non-empty video file");
		const id = randomBytes(32).toString("hex");
		const ticket: Ticket = {
			version: 1,
			path,
			name: basename(path),
			mime,
			size: st.size,
			mtimeMs: st.mtimeMs,
			ino: st.ino,
			dev: st.dev,
			expiresAt: Date.now() + TTL_MS,
		};
		await writeFile(
			join(await privateRoot(), `${id}.json`),
			JSON.stringify(ticket),
			{ flag: "wx", mode: 0o600 },
		);
		return id;
	} finally {
		await handle.close();
	}
}

export async function readLocalOpenTicket(id: string): Promise<Ticket> {
	if (!TICKET_ID.test(id)) throw new Error("Invalid local import ticket");
	const file = await open(
		join(await privateRoot(), `${id}.json`),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const st = await file.stat();
		if (
			!st.isFile() ||
			st.size > 16_384 ||
			(st.mode & 0o077) !== 0 ||
			st.uid !== process.getuid?.()
		)
			throw new Error("Invalid local import ticket");
		const t = TicketSchema.parse(JSON.parse(await file.readFile("utf8")));
		if (
			t.version !== 1 ||
			typeof t.path !== "string" ||
			!t.path.startsWith("/") ||
			t.name !== basename(t.path) ||
			MIME_TYPES[extname(t.path).toLowerCase()] !== t.mime ||
			![t.size, t.mtimeMs, t.ino, t.dev, t.expiresAt].every(Number.isFinite) ||
			t.expiresAt < Date.now() ||
			t.expiresAt > Date.now() + TTL_MS
		)
			throw new Error("Local import ticket is invalid or expired");
		return t;
	} finally {
		await file.close();
	}
}

export async function openTicketVideo(ticket: Ticket) {
	const file = await open(
		ticket.path,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	const st = await file.stat();
	if (
		!st.isFile() ||
		st.size !== ticket.size ||
		st.mtimeMs !== ticket.mtimeMs ||
		st.ino !== ticket.ino ||
		st.dev !== ticket.dev
	) {
		await file.close();
		throw new Error("The selected video changed. Open it from Dolphin again.");
	}
	return file;
}

export async function completeLocalOpenTicket(id: string): Promise<void> {
	if (!TICKET_ID.test(id)) throw new Error("Invalid local import ticket");
	// Only remove the handoff metadata, never the selected media file.
	await unlink(join(await privateRoot(), `${id}.json`));
}

export function requireLocalOpenRequest(request: Request): void {
	if (process.env.OPENCUT_LOCAL_FILES !== "1")
		throw new Error("Desktop file import is disabled");
	const url = new URL(request.url);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
		throw new Error("Local requests only");
	const origin = request.headers.get("origin");
	// Next may construct request.url with its internal "localhost" hostname,
	// while the browser correctly sends Origin: http://127.0.0.1:3003.
	// Validate the actual Host header as well; never trust forwarded hosts.
	const clientUrl = new URL(
		`${url.protocol}//${request.headers.get("host") ?? url.host}`,
	);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(clientUrl.hostname))
		throw new Error("Local requests only");
	if (origin && origin !== clientUrl.origin)
		throw new Error("Same-origin requests only");
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none")
		throw new Error("Same-origin requests only");
}
