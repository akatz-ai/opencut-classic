import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	completeLocalOpenTicket,
	createLocalOpenTicket,
	openTicketVideo,
	readLocalOpenTicket,
	requireLocalOpenRequest,
} from "./tickets";

let sandbox: string;
const previousRoot = process.env.OPENCUT_LOCAL_OPEN_DIR;
const previousEnabled = process.env.OPENCUT_LOCAL_FILES;
beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "opencut-local-open-test-"));
	process.env.OPENCUT_LOCAL_OPEN_DIR = join(sandbox, "tickets");
	process.env.OPENCUT_LOCAL_FILES = "1";
});
afterEach(async () => {
	if (previousRoot === undefined) delete process.env.OPENCUT_LOCAL_OPEN_DIR;
	else process.env.OPENCUT_LOCAL_OPEN_DIR = previousRoot;
	if (previousEnabled === undefined) delete process.env.OPENCUT_LOCAL_FILES;
	else process.env.OPENCUT_LOCAL_FILES = previousEnabled;
	await rm(sandbox, { recursive: true, force: true });
});

describe("local desktop file handoff", () => {
	test("spaces, quotes, Unicode and shell characters stay literal; completion preserves original", async () => {
		const path = join(sandbox, "my 'clip' $name ; é.MP4");
		await writeFile(path, "test video");
		const id = await createLocalOpenTicket(path);
		expect(id).toMatch(/^[a-f0-9]{64}$/);
		expect(
			(await stat(join(process.env.OPENCUT_LOCAL_OPEN_DIR!, `${id}.json`)))
				.mode & 0o777,
		).toBe(0o600);
		const ticket = await readLocalOpenTicket(id);
		expect(ticket.mime).toBe("video/mp4");
		const file = await openTicketVideo(ticket);
		expect(await file.readFile("utf8")).toBe("test video");
		await file.close();
		await completeLocalOpenTicket(id);
		await expect(readLocalOpenTicket(id)).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("test video");
	});
	test("separate launches get independent tickets", async () => {
		const path = join(sandbox, "clip.webm");
		await writeFile(path, "video");
		expect(await createLocalOpenTicket(path)).not.toBe(
			await createLocalOpenTicket(path),
		);
	});
	test("rejects traversal, non-video, empty and missing files", async () => {
		await expect(readLocalOpenTicket("../../anything")).rejects.toThrow();
		const path = join(sandbox, "secret.txt");
		await writeFile(path, "secret");
		await expect(createLocalOpenTicket(path)).rejects.toThrow();
		await writeFile(join(sandbox, "empty.mp4"), "");
		await expect(
			createLocalOpenTicket(join(sandbox, "empty.mp4")),
		).rejects.toThrow();
		await expect(
			createLocalOpenTicket(join(sandbox, "missing.mp4")),
		).rejects.toThrow();
	});
	test("rejects an expired ticket and changed selected file", async () => {
		const path = join(sandbox, "clip.mov");
		await writeFile(path, "video");
		const id = await createLocalOpenTicket(path);
		const ticket = await readLocalOpenTicket(id);
		await writeFile(path, "different video");
		await expect(openTicketVideo(ticket)).rejects.toThrow("changed");
		await writeFile(
			join(process.env.OPENCUT_LOCAL_OPEN_DIR!, `${id}.json`),
			JSON.stringify({ ...ticket, expiresAt: 1 }),
		);
		await expect(readLocalOpenTicket(id)).rejects.toThrow();
	});
	test("resolves user-selected symlinks but rejects symlinked ticket files and public metadata", async () => {
		const path = join(sandbox, "clip.mkv");
		await writeFile(path, "video");
		const link = join(sandbox, "linked.mkv");
		await symlink(path, link);
		const id = await createLocalOpenTicket(link);
		expect((await readLocalOpenTicket(id)).path).toBe(path);
		const ticketPath = join(process.env.OPENCUT_LOCAL_OPEN_DIR!, `${id}.json`);
		await chmod(ticketPath, 0o644);
		await expect(readLocalOpenTicket(id)).rejects.toThrow();
		const maliciousId = "a".repeat(64);
		await symlink(
			ticketPath,
			join(process.env.OPENCUT_LOCAL_OPEN_DIR!, `${maliciousId}.json`),
		);
		await expect(readLocalOpenTicket(maliciousId)).rejects.toThrow();
	});
	test("HTTP bridge is opt-in, loopback-only and same-origin", () => {
		const url = "http://127.0.0.1:3003/api/local-open";
		expect(() =>
			requireLocalOpenRequest(
				new Request(url, {
					headers: {
						origin: "http://127.0.0.1:3003",
						"sec-fetch-site": "same-origin",
					},
				}),
			),
		).not.toThrow();
		expect(() =>
			requireLocalOpenRequest(
				new Request(url, { headers: { origin: "https://evil.example" } }),
			),
		).toThrow();
		expect(() =>
			requireLocalOpenRequest(
				new Request(url, { headers: { "sec-fetch-site": "cross-site" } }),
			),
		).toThrow();
		expect(() =>
			requireLocalOpenRequest(
				new Request("http://evil.example/api/local-open"),
			),
		).toThrow();
		delete process.env.OPENCUT_LOCAL_FILES;
		expect(() => requireLocalOpenRequest(new Request(url))).toThrow();
	});
	test("Next internal localhost URL still requires the browser's actual loopback Host origin", () => {
		const request = new Request("http://localhost:3003/api/local-open", {
			headers: {
				host: "127.0.0.1:3003",
				origin: "http://127.0.0.1:3003",
				"sec-fetch-site": "same-origin",
			},
		});
		expect(() => requireLocalOpenRequest(request)).not.toThrow();
		expect(() =>
			requireLocalOpenRequest(
				new Request("http://localhost:3003/api/local-open", {
					headers: { host: "evil.example", origin: "http://evil.example" },
				}),
			),
		).toThrow();
	});
});
