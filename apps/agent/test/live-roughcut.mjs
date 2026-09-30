import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!process.env.PLAYWRIGHT_MODULE)
	throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const exec = promisify(execFile),
	out = await mkdtemp(join(tmpdir(), "opencut-live-test-")),
	origin = process.env.ORIGIN ?? "http://127.0.0.1:3004";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
	throw new Error("Live tests require a loopback server");
console.log("Artifacts:", out);
await exec("ffmpeg", [
	"-v",
	"error",
	"-f",
	"lavfi",
	"-i",
	"testsrc2=size=640x360:rate=30:duration=6",
	"-f",
	"lavfi",
	"-i",
	"sine=frequency=440:sample_rate=48000:duration=6",
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
const { Client } = await import(
	`${repo}/apps/agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`
);
const { StdioClientTransport } = await import(
	`${repo}/apps/agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`
);
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
const page = await ctx.newPage(),
	errors = [],
	warnings = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (e) => {
	if (e.type() === "error" || e.type() === "warning") warnings.push(e.text());
});
async function cli(...args) {
	const r = await exec("bun", ["apps/agent/src/cli.ts", ...args], {
		cwd: repo,
		env: { ...process.env, OPENCUT_AGENT_URL: origin },
		maxBuffer: 2e6,
	});
	return JSON.parse(r.stdout);
}
let project, session;
async function inspect(detail = "overview") {
	return cli(
		"inspect",
		"--project",
		project,
		"--session",
		session,
		"--detail",
		detail,
	);
}
async function edit(plan, key, revision, dry = false) {
	const path = `${out}/${key}.json`;
	await writeFile(path, JSON.stringify({ operations: plan }));
	return cli(
		"edit",
		"--project",
		project,
		"--session",
		session,
		"--expected-revision",
		revision,
		"--key",
		key,
		"--plan",
		path,
		...(dry ? ["--dry-run"] : []),
	);
}
async function fresh() {
	await page.waitForTimeout(1250);
	return inspect();
}
try {
	await page.goto(`${origin}/projects`);
	await page.waitForTimeout(1400);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await page.waitForFunction(() => !!window.__opencutAgentSnapshot?.sessionId);
	await page.keyboard.press("Escape");
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await (await chooser).setFiles(`${out}/source.mp4`);
	await page.waitForFunction(
		() => window.__opencutAgentSnapshot?.media.length === 1,
	);
	const initial = await page.evaluate(() => window.__opencutAgentSnapshot);
	project = initial.project.id;
	session = initial.sessionId;
	await writeFile(`${out}/project.json`, JSON.stringify({ project, session }));
	let s = await fresh();
	const media = await inspect("media");
	assert.equal(s.mediaCount, 1);
	assert(!("media" in s));
	assert(!("tracks" in s.activeScene));
	const cat = await cli("catalog", "--project", project, "--session", session);
	assert(cat.success);
	assert(cat.result.definitions.includes("graphic:akatz-arrow"));
	const plan = [
		{
			op: "insert",
			id: "shot-one",
			trackId: s.tracks.find((t) => t.type === "video").id,
			kind: "video",
			mediaId: media.items[0].id,
			startSeconds: 0,
			durationSeconds: 1,
			sourceInSeconds: 0,
		},
		{
			op: "insert",
			id: "shot-two",
			trackId: s.tracks.find((t) => t.type === "video").id,
			kind: "video",
			mediaId: media.items[0].id,
			startSeconds: 1,
			durationSeconds: 2,
			sourceInSeconds: 2,
		},
		{
			op: "setMotion",
			id: "shot-two",
			edge: "cut",
			kind: "slide-left",
			durationSeconds: 0.3,
		},
		{
			op: "setEffect",
			id: "shot-one",
			effectId: "color-one",
			effectType: "color-adjust",
			params: { saturation: 0 },
		},
		{ op: "addTrack", id: "titles", kind: "text", name: "Agent titles" },
		{
			op: "insert",
			id: "title-one",
			trackId: "titles",
			kind: "text",
			startSeconds: 0,
			durationSeconds: 3,
			params: {
				content: "AGENT ROUGH CUT",
				fontSize: 10,
				"transform.positionY": -100,
			},
		},
		{
			op: "setMotion",
			id: "title-one",
			edge: "enter",
			kind: "pop",
			durationSeconds: 0.3,
		},
		{ op: "addTrack", id: "graphics", kind: "graphic", name: "Agent graphics" },
		{
			op: "insert",
			id: "arrow-one",
			trackId: "graphics",
			kind: "graphic",
			definitionId: "akatz-arrow",
			startSeconds: 0,
			durationSeconds: 3,
			params: {
				"transform.scaleX": 0.2,
				"transform.scaleY": 0.2,
				"transform.positionY": 80,
			},
		},
	];
	const before = await inspect("full");
	const dry = await edit(plan, "roughcut-dry", s.revision, true);
	assert(dry.success && dry.result.dryRun);
	assert.equal((await fresh()).revision, s.revision);
	const done = await edit(plan, "roughcut-commit", s.revision);
	assert(done.success);
	assert.equal(done.result.durationSeconds, 3);
	const originalRevision = s.revision;
	s = await fresh();
	assert.notEqual(s.revision, originalRevision);
	assert.equal(
		s.tracks.reduce((n, t) => n + t.clipCount, 0),
		4,
	);
	const same = await edit(plan, "roughcut-commit", originalRevision);
	assert.equal(same.commandId, done.commandId);
	assert.equal((await fresh()).revision, s.revision);
	await assert.rejects(
		() => edit(plan, "roughcut-stale", originalRevision),
		/Revision/,
	);
	await assert.rejects(
		() =>
			edit(
				[{ op: "remove", id: "shot-one" }],
				"roughcut-commit",
				originalRevision,
			),
		/different/,
	);
	await assert.rejects(() =>
		edit(
			[
				{ op: "remove", id: "shot-one" },
				{ op: "remove", id: "missing" },
			],
			"invalid-atomic",
			s.revision,
		),
	);
	assert.equal((await fresh()).revision, s.revision);
	await page.getByRole("button", { name: "Agent ready", exact: true }).click();
	await fresh();
	await assert.rejects(
		() => edit([{ op: "remove", id: "shot-one" }], "paused-test", s.revision),
		/paused/,
	);
	await page.getByRole("button", { name: "Agent paused", exact: true }).click();
	await fresh();
	// User undo/redo, not browser-console state manipulation.
	await page.keyboard.press("Control+z");
	let undone = await fresh();
	assert.equal(
		undone.tracks.reduce((n, t) => n + t.clipCount, 0),
		0,
	);
	await edit(plan, "roughcut-commit", originalRevision);
	assert.equal(
		(await fresh()).revision,
		undone.revision,
		"retry never replays after undo",
	);
	await page.keyboard.press("Control+Shift+z");
	s = await fresh();
	assert.equal(
		s.tracks.reduce((n, t) => n + t.clipCount, 0),
		4,
	);
	await page.reload();
	await page.waitForFunction(() => !!window.__opencutAgentSnapshot?.sessionId);
	await page.keyboard.press("Escape");
	const reloaded = await page.evaluate(() => window.__opencutAgentSnapshot);
	assert.notEqual(session, reloaded.sessionId);
	session = reloaded.sessionId;
	s = await fresh();
	assert.equal(
		s.tracks.reduce((n, t) => n + t.clipCount, 0),
		4,
	);
	// Exercise the actual MCP transport, not a direct browser helper.
	const mcp = new Client({ name: "roughcut-verification", version: "1.0" });
	await mcp.connect(
		new StdioClientTransport({
			command: "bun",
			args: [`${repo}/apps/agent/src/mcp.ts`],
			env: { ...process.env, OPENCUT_AGENT_URL: origin },
		}),
	);
	try {
		const tools = await mcp.listTools();
		assert(tools.tools.some((t) => t.name === "edit_timeline"));
		const overview = await mcp.callTool({
			name: "inspect_project",
			arguments: { project_id: project, session_id: session },
		});
		assert(overview.structuredContent.sessionId === session);
		const changed = await mcp.callTool({
			name: "edit_timeline",
			arguments: {
				project_id: project,
				session_id: session,
				expected_revision: s.revision,
				idempotency_key: "mcp-revision",
				dry_run: false,
				operations: [
					{ op: "setParams", id: "arrow-one", params: { fill: "#FF209B" } },
					{
						op: "move",
						id: "arrow-one",
						trackId: "graphics",
						startSeconds: 0.1,
					},
					{ op: "remove", id: "title-one" },
				],
			},
		});
		assert(changed.structuredContent.success, JSON.stringify(changed));
		const current = await fresh();
		assert.equal(
			current.tracks.reduce((n, t) => n + t.clipCount, 0),
			3,
		);
		await page.keyboard.press("Control+z");
		s = await fresh();
		assert.equal(
			s.tracks.reduce((n, t) => n + t.clipCount, 0),
			4,
		);
	} finally {
		await mcp.close();
	}
	// A human edit while the legacy asynchronous cut planner is working must win.
	let release, seen;
	const held = new Promise((r) => (release = r)),
		entered = new Promise((r) => (seen = r));
	await page.route("**/api/agent-bridge/plan-cuts", async (route) => {
		seen();
		await held;
		await route.continue();
	});
	await writeFile(
		`${out}/cut-race.json`,
		JSON.stringify({ ranges: [{ startSeconds: 0.1, endSeconds: 0.2 }] }),
	);
	const race = cli(
		"apply-cuts",
		"--project",
		project,
		"--session",
		session,
		"--expected-revision",
		s.revision,
		"--plan",
		`${out}/cut-race.json`,
	).then(
		(r) => ({ result: r }),
		(e) => ({ error: e }),
	);
	await Promise.race([
		entered,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Cut planner did not start")), 10000),
		),
	]);
	await page.keyboard.press("Control+Shift+z");
	const humanRevision = (await fresh()).revision;
	assert.notEqual(humanRevision, s.revision);
	release();
	const raceResult = await race;
	assert(raceResult.error);
	assert.match(JSON.parse(raceResult.error.stdout).error, /Editor changed/);
	assert.equal((await fresh()).revision, humanRevision);
	await page.unroute("**/api/agent-bridge/plan-cuts");
	await page.keyboard.press("Control+z");
	s = await fresh();
	assert.equal(
		s.tracks.reduce((n, t) => n + t.clipCount, 0),
		4,
	);
	// Focused human input is protected from agent mutations.
	const busyTimecode = page.getByRole("button", {
		name: /^\d{2}:\d{2}:\d{2}:\d{2}$/,
	});
	await busyTimecode.click();
	const busy = await edit(
		[{ op: "remove", id: "shot-one" }],
		"busy-test",
		s.revision,
	).then(
		(r) => ({ result: r }),
		(e) => ({ error: e }),
	);
	assert(busy.error);
	assert.match(JSON.parse(busy.error.stdout).error, /Editor busy/);
	await page.keyboard.press("Escape");
	const timecode = page.getByRole("button", {
		name: /^\d{2}:\d{2}:\d{2}:\d{2}$/,
	});
	const old = await timecode.innerText();
	await timecode.click();
	const input = page.getByPlaceholder(old);
	await input.fill("00:00:00:15");
	await input.press("Enter");
	await page.waitForTimeout(900);
	await page.screenshot({ path: `${out}/live-roughcut.png` });
	let canvas;
	for (const c of await page.locator("canvas:visible").all()) {
		const b = await c.boundingBox();
		if (b?.width > 500 && b.height > 250) {
			canvas = c;
			break;
		}
	}
	assert(canvas);
	await canvas.screenshot({ path: `${out}/preview.png` });
	const exported = await cli(
		"export-project",
		"--project",
		project,
		"--session",
		session,
		"--expected-revision",
		s.revision,
		"--width",
		"640",
		"--height",
		"360",
		"--fps",
		"30",
		"--video-bitrate",
		"2000000",
		"--filename",
		"agent-roughcut-proof.mp4",
	);
	assert(exported.success);
	await writeFile(`${out}/export.json`, JSON.stringify(exported, null, 2));
	await writeFile(
		`${out}/result.json`,
		JSON.stringify(
			{
				project,
				session,
				revision: s.revision,
				checks: [
					"CLI dry-run",
					"CLI live commit",
					"idempotent retry",
					"stale revision",
					"changed key inputs",
					"atomic rejection",
					"pause",
					"undo",
					"retry-after-undo",
					"redo",
					"save/reload",
					"MCP inspect/edit",
					"concurrent human edit",
					"focused-input protection",
					"preview",
					"export",
				],
				errors,
				warnings,
			},
			null,
			2,
		),
	);
	assert.equal(errors.length, 0);
	console.log("PASS", JSON.stringify({ project, session, exported }));
} catch (e) {
	await page.screenshot({ path: `${out}/failure.png` });
	console.log("WARNINGS", warnings);
	throw e;
} finally {
	console.log("ERRORS", errors);
	await ctx.close();
}
