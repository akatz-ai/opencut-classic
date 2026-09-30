import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const exec = promisify(execFile);
const out = await mkdtemp(join(tmpdir(), "opencut-audio-fades-test-"));
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
	"sine=frequency=440:sample_rate=48000:duration=4",
	"-c:a",
	"pcm_s16le",
	`${out}/source.wav`,
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
const page = await ctx.newPage();
page.setDefaultTimeout(30_000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

async function cli(...args) {
	const result = await exec("bun", ["apps/agent/src/cli.ts", ...args], {
		cwd: repo,
		env: { ...process.env, OPENCUT_AGENT_URL: origin },
		maxBuffer: 2e6,
	});
	return JSON.parse(result.stdout);
}

try {
	await page.goto(`${origin}/projects`);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await page.waitForFunction(() => !!window.__opencutAgentSnapshot?.sessionId);
	await page.keyboard.press("Escape");
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await (await chooser).setFiles(`${out}/source.wav`);
	await page.waitForFunction(
		() => window.__opencutAgentSnapshot?.media.length === 1,
	);
	await page.waitForTimeout(1000);
	const initial = await page.evaluate(() => window.__opencutAgentSnapshot);
	const scoped = [
		"--project",
		initial.project.id,
		"--session",
		initial.sessionId,
	];
	const before = await cli("inspect", ...scoped);
	await writeFile(
		`${out}/insert.json`,
		JSON.stringify({
			operations: [
				{ op: "addTrack", id: "fade-track", kind: "audio", name: "Fade test" },
				{
					op: "insert",
					id: "fade-clip",
					trackId: "fade-track",
					kind: "audio",
					mediaId: initial.media[0].id,
					startSeconds: 0,
					sourceInSeconds: 0,
					durationSeconds: 4,
				},
			],
		}),
	);
	const inserted = await cli(
		"edit",
		...scoped,
		"--expected-revision",
		before.revision,
		"--key",
		"audio-fade-smoke",
		"--plan",
		`${out}/insert.json`,
	);
	assert(inserted.success, JSON.stringify(inserted));
	await page.waitForFunction(() =>
		document.querySelector('[data-audio-fade="in"]'),
	);

	async function dragFade(side, fraction) {
		const handle = page.locator(`[data-audio-fade="${side}"]`);
		const surface = handle.locator("xpath=..");
		const box = await surface.boundingBox();
		const handleBox = await handle.boundingBox();
		assert(box && handleBox);
		await page.mouse.move(
			handleBox.x + handleBox.width / 2,
			handleBox.y + handleBox.height / 2,
		);
		await page.mouse.down();
		await page.mouse.move(
			box.x + box.width * fraction,
			box.y + box.height / 2,
			{
				steps: 8,
			},
		);
		await page.mouse.up();
		await page.waitForTimeout(500);
	}

	await dragFade("in", 0.25);
	await dragFade("out", 0.75);
	const snapshot = await page.evaluate(() => window.__opencutAgentSnapshot);
	const clip = snapshot.activeScene.tracks.audio
		.flatMap((track) => track.elements)
		.find((element) => element.id === "fade-clip");
	assert(clip);
	assert(Math.abs(clip.fadeInDuration / 120_000 - 1) < 0.08);
	assert(Math.abs(clip.fadeOutDuration / 120_000 - 1) < 0.08);
	for (const name of ["Audio fade in", "Audio fade out"]) {
		const text = await page
			.getByRole("slider", { name })
			.getAttribute("aria-valuetext");
		assert(text?.endsWith("s"));
		assert(Math.abs(Number.parseFloat(text) - 1) < 0.08);
	}
	await page.screenshot({ path: `${out}/audio-fades.png` });

	await page.keyboard.press("Control+z");
	await page.waitForTimeout(400);
	let undone = await page.evaluate(() => window.__opencutAgentSnapshot);
	let undoneClip = undone.activeScene.tracks.audio[0].elements[0];
	assert.equal(undoneClip.fadeOutDuration ?? 0, 0);
	await page.keyboard.press("Control+Shift+z");
	await page.waitForTimeout(400);
	const redone = await page.evaluate(() => window.__opencutAgentSnapshot);
	assert(
		Math.abs(
			redone.activeScene.tracks.audio[0].elements[0].fadeOutDuration / 120_000 -
				1,
		) < 0.08,
	);

	const current = await cli("inspect", ...scoped);
	const exported = await cli(
		"export-project",
		...scoped,
		"--expected-revision",
		current.revision,
		"--width",
		"320",
		"--height",
		"180",
		"--fps",
		"30",
		"--video-bitrate",
		"1000000",
		"--filename",
		"audio-fades-proof.mp4",
	);
	assert(exported.success, JSON.stringify(exported));
	const artifactPath = exported.result?.artifact?.path;
	assert.equal(typeof artifactPath, "string");
	async function meanVolume({ start, duration }) {
		const measured = await exec("ffmpeg", [
			"-hide_banner",
			"-ss",
			String(start),
			"-t",
			String(duration),
			"-i",
			artifactPath,
			"-vn",
			"-af",
			"volumedetect",
			"-f",
			"null",
			"-",
		]);
		const match = measured.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
		assert(match, measured.stderr);
		return Number(match[1]);
	}
	const levels = {
		start: await meanVolume({ start: 0.02, duration: 0.12 }),
		middle: await meanVolume({ start: 1.8, duration: 0.12 }),
		end: await meanVolume({ start: 3.86, duration: 0.12 }),
	};
	assert(levels.middle - levels.start > 15, JSON.stringify(levels));
	assert(levels.middle - levels.end > 15, JSON.stringify(levels));
	assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
	await writeFile(
		`${out}/result.json`,
		JSON.stringify({ clip, exported, levels, pageErrors }, null, 2),
	);
	console.log("PASS", JSON.stringify({ clip, exported, levels }));
} catch (error) {
	await page.screenshot({ path: `${out}/failure.png` });
	await writeFile(`${out}/failure.txt`, await page.locator("body").innerText());
	throw error;
} finally {
	await ctx.close();
}
