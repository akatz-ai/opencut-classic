// Real Web Audio regression test, independent of the user's browser/profile.
// Run from the repository root: bun integrations/linux/check-preview-audio.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const built = await Bun.build({
	entrypoints: [join(import.meta.dir, "preview-audio-regression.browser.ts")],
	target: "browser",
});
if (!built.success) throw new Error(built.logs.join("\n"));
const bundle = await built.outputs[0].text();
const chrome = process.env.CHROME_BIN ?? Bun.which("google-chrome");
if (!chrome)
	throw new Error("Set CHROME_BIN to an installed Chrome/Chromium executable");
const profile = await mkdtemp(join(tmpdir(), "opencut-audio-regression-"));
let resolveResult: (value: unknown) => void;
const result = new Promise<unknown>((resolve) => {
	resolveResult = resolve;
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/result" && request.method === "POST") {
			resolveResult(await request.json());
			return new Response("ok");
		}
		if (path === "/check.js")
			return new Response(bundle, {
				headers: { "Content-Type": "text/javascript" },
			});
		return new Response('<!doctype html><script src="/check.js"></script>', {
			headers: { "Content-Type": "text/html" },
		});
	},
});
const browser = Bun.spawn(
	[
		chrome,
		"--headless=new",
		"--no-first-run",
		`--user-data-dir=${profile}`,
		String(server.url),
	],
	{ stdout: "ignore", stderr: "ignore" },
);
let timer: ReturnType<typeof setTimeout> | undefined;
try {
	const report = (await Promise.race([
		result,
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Browser audio check timed out")),
				45_000,
			);
		}),
	])) as { error?: string; results?: Array<{ peakDifference: number }> };
	console.log(JSON.stringify(report, null, 2));
	if (
		report.error ||
		report.results?.length !== 30 ||
		report.results.some((row) => row.peakDifference > 0.00001)
	) {
		throw new Error("Preview PCM differs from continuous resampling");
	}
	console.log("PASS: 30 real-browser sample-rate / speed / seek comparisons");
} finally {
	clearTimeout(timer);
	browser.kill();
	await browser.exited;
	server.stop(true);
	// Only the unique temporary test profile created above, never a user profile.
	await rm(profile, {
		recursive: true,
		force: true,
		maxRetries: 3,
		retryDelay: 100,
	});
}
