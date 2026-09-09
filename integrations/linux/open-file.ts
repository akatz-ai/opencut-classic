#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLocalOpenTicket } from "../../apps/web/src/server/local-open/tickets";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("A video file is required");
try {
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const response = await fetch("http://127.0.0.1:3003/api/health", {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {
			/* The user service may still be starting. */
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (!ready)
		throw new Error(
			"OpenCut's local server is not ready. Try again in a moment.",
		);
	for (const input of files) {
		const ticket = await createLocalOpenTicket(
			input.startsWith("file:") ? fileURLToPath(input) : input,
		);
		const child = spawn(
			"/home/akatz/.local/bin/opencut-classic-launch",
			["--local-import", `http://127.0.0.1:3003/open-local#ticket=${ticket}`],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
	}
} catch (error) {
	spawn(
		"notify-send",
		[
			"OpenCut import failed",
			error instanceof Error ? error.message : "Could not open the video",
		],
		{ stdio: "ignore" },
	);
	console.error("OpenCut could not open the selected video.");
	process.exitCode = 1;
}
