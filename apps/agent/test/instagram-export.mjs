// Run against an isolated local server. Never touches the desktop app's profile.
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const exec = promisify(execFile);
const out = await mkdtemp(join(tmpdir(), "opencut-instagram-test-"));
const origin = process.env.ORIGIN ?? "http://127.0.0.1:3004";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
console.log("Artifacts:", out);
await exec("ffmpeg", [
	"-v",
	"error",
	"-f",
	"lavfi",
	"-i",
	"color=c=red:size=640x360:rate=30:duration=0.5",
	"-f",
	"lavfi",
	"-i",
	"sine=frequency=440:sample_rate=48000:duration=0.5",
	"-c:v",
	"libx264",
	"-preset",
	"ultrafast",
	"-pix_fmt",
	"yuv420p",
	"-c:a",
	"aac",
	"-shortest",
	`${out}/source.mp4`,
]);
const ctx = await chromium.launchPersistentContext(`${out}/profile`, {
	executablePath: process.env.CHROME_BIN ?? "/opt/google/chrome/chrome",
	headless: false,
	viewport: { width: 1600, height: 1000 },
	args: [
		"--ozone-platform=wayland",
		"--render-node-override=/dev/dri/renderD128",
		"--enable-features=UseOzonePlatform,WebGPUService,WebGPU",
		"--disable-features=Vulkan",
		"--disable-backgrounding-occluded-windows",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
	],
});
await ctx.addInitScript(() => {
	window.showSaveFilePicker = undefined;
});
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const errors = [],
	results = [];
page.on("pageerror", (e) => errors.push(e.message));
async function cli(...args) {
	const r = await exec("bun", ["apps/agent/src/cli.ts", ...args], {
		cwd: repo,
		env: { ...process.env, OPENCUT_AGENT_URL: origin },
		maxBuffer: 2e6,
	});
	return JSON.parse(r.stdout);
}
try {
	await page.goto(`${origin}/projects`);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await page.waitForFunction(() => !!window.__opencutAgentSnapshot?.sessionId);
	await page.keyboard.press("Escape");
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await (await chooser).setFiles(`${out}/source.mp4`);
	await page.waitForFunction(
		() => window.__opencutAgentSnapshot?.media.length === 1,
	);
	await page.waitForTimeout(1500);
	const initial = await page.evaluate(() => window.__opencutAgentSnapshot);
	const scoped = [
		"--project",
		initial.project.id,
		"--session",
		initial.sessionId,
	];
	const s = await cli("inspect", ...scoped);
	await writeFile(
		`${out}/insert.json`,
		JSON.stringify({
			operations: [
				{
					op: "insert",
					id: "export-test",
					trackId: s.tracks.find((t) => t.type === "video").id,
					kind: "video",
					mediaId: initial.media[0].id,
					startSeconds: 0,
					sourceInSeconds: 0,
					durationSeconds: 0.5,
				},
			],
		}),
	);
	const edit = await cli(
		"edit",
		...scoped,
		"--expected-revision",
		s.revision,
		"--key",
		"instagram-test",
		"--plan",
		`${out}/insert.json`,
	);
	assert(edit.success, JSON.stringify(edit));
	for (const [orientation, canvasWidth, canvasHeight] of [
		["landscape", 2688, 1536],
		["portrait", 1080, 1920],
	]) {
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		if (!(await page.getByLabel("Canvas width").isVisible())) {
			await page.getByRole("button", { name: "Custom", exact: true }).click();
		}
		const width = page.getByLabel("Canvas width");
		const height = page.getByLabel("Canvas height");
		await width.fill(String(canvasWidth));
		await width.press("Tab");
		await height.fill(String(canvasHeight));
		await height.press("Tab");
		await page.waitForTimeout(600);
		for (const [label, long, short] of [
			["Insta HD", 1920, 1080],
			["Insta 2K", 2560, 1440],
			["Insta 4K", 3840, 2160],
		]) {
			const w = orientation === "portrait" ? short : long;
			const h = orientation === "portrait" ? long : short;
			const name = `${orientation}-${label.replaceAll(" ", "-")}`;
			await page.getByRole("button", { name: "Export", exact: true }).click();
			const panel = page.getByRole("dialog");
			await panel.getByRole("combobox").first().focus();
			await panel.getByRole("combobox").first().press("Space");
			await page
				.getByRole("option", { name: `${label} · ${w}×${h}`, exact: true })
				.click();
			await panel
				.getByRole("slider", { name: "Encoding quality" })
				.press("End");
			assert.equal(
				await panel
					.getByRole("slider", { name: "Encoding quality" })
					.getAttribute("aria-valuenow"),
				"100",
			);
			assert((await panel.innerText()).includes(`Resolution stays ${w}×${h}`));
			await panel.screenshot({ path: `${out}/${name}.png` });
			const download = page.waitForEvent("download", { timeout: 120000 });
			await panel.getByRole("button", { name: "Export", exact: true }).click();
			await (await download).saveAs(`${out}/${name}.mp4`);
			const probe = JSON.parse(
				(
					await exec("ffprobe", [
						"-v",
						"error",
						"-show_streams",
						"-of",
						"json",
						`${out}/${name}.mp4`,
					])
				).stdout,
			);
			const video = probe.streams.find((s) => s.codec_type === "video");
			const audio = probe.streams.find((s) => s.codec_type === "audio");
			assert.equal(video.width, w);
			assert.equal(video.height, h);
			assert.equal(video.codec_name, "h264");
			assert.equal(audio?.codec_name, "aac");
			assert(Number(video.duration) >= 0.49);
			if (orientation === "landscape" && label === "Insta 4K") {
				const decoded = await exec(
					"ffmpeg",
					[
						"-v",
						"error",
						"-i",
						`${out}/${name}.mp4`,
						"-frames:v",
						"1",
						"-f",
						"rawvideo",
						"-pix_fmt",
						"rgb24",
						"pipe:1",
					],
					{ encoding: "buffer", maxBuffer: 30e6 },
				);
				const pixel = (x) => [
					...decoded.stdout.subarray(
						(1080 * 3840 + x) * 3,
						(1080 * 3840 + x) * 3 + 3,
					),
				];
				assert(pixel(10).every((v) => v < 10));
				assert(pixel(3830).every((v) => v < 10));
				assert(pixel(40)[0] > 230 && pixel(40)[1] < 50);
			}
			results.push({
				name,
				width: w,
				height: h,
				codec: video.codec_name,
				audio: audio.codec_name,
				duration: video.duration,
			});
			console.log("PASS", results.at(-1));
			await page.waitForTimeout(500);
			await page.keyboard.press("Escape");
		}
	}
	assert.equal(errors.length, 0, JSON.stringify(errors));
} catch (error) {
	await page.screenshot({ path: `${out}/failure.png` });
	await writeFile(`${out}/failure.txt`, await page.locator("body").innerText());
	throw error;
} finally {
	await writeFile(
		`${out}/results.json`,
		JSON.stringify({ results, errors }, null, 2),
	);
	await ctx.close();
}
