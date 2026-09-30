import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listAgentStates,
	queueAgentCommand,
	readAgentState,
	saveAgentState,
	takeAgentCommand,
} from "./store";
import type { AgentProjectSnapshot } from "@/agent-bridge/types";
import { presentAgentState } from "@/agent-bridge/inspect";

let directory: string;
const previous = process.env.OPENCUT_AGENT_BRIDGE_DIR;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-bridge-test-"));
	process.env.OPENCUT_AGENT_BRIDGE_DIR = directory;
});
afterAll(() => {
	if (previous === undefined) delete process.env.OPENCUT_AGENT_BRIDGE_DIR;
	else process.env.OPENCUT_AGENT_BRIDGE_DIR = previous;
});
// Compact test fixture factory.
// eslint-disable-next-line opencut/prefer-object-params
function state(
	projectId: string,
	sessionId = "session-one",
): AgentProjectSnapshot {
	return {
		sessionId,
		revision: "revision-one",
		capturedAt: new Date().toISOString(),
		project: {
			id: projectId,
			name: "Fixture",
			durationSeconds: 0,
			fps: 30,
			canvasSize: { width: 640, height: 360 },
		},
		activeScene: {
			id: "scene",
			name: "Scene",
			tracks: {
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				overlay: [],
				audio: [],
			},
		},
		media: [],
		playheadSeconds: 0,
	};
}
test("only fresh sessions; ambiguous project requires a session", async () => {
	await saveAgentState(state("ambiguous", "one"));
	await saveAgentState(state("ambiguous", "two"));
	await expect(readAgentState({ projectId: "ambiguous" })).rejects.toThrow(
		"Multiple",
	);
	expect(
		(await readAgentState({ projectId: "ambiguous", sessionId: "one" }))
			?.sessionId,
	).toBe("one");
	const path = join(directory, "sessions", "two.json");
	const old = JSON.parse(await readFile(path, "utf8"));
	old.receivedAt = "2000-01-01T00:00:00Z";
	await writeFile(path, JSON.stringify(old));
	expect((await listAgentStates()).some((s) => s.sessionId === "two")).toBe(
		false,
	);
});
test("batch requires explicit session revision and key, rejects stale or paused", async () => {
	await saveAgentState(state("guard", "guard-session"));
	const base = { projectId: "guard", kind: "edit_batch" as const, payload: {} };
	await expect(queueAgentCommand(base)).rejects.toThrow("requires");
	await expect(
		queueAgentCommand({
			...base,
			sessionId: "guard-session",
			expectedRevision: "old",
			idempotencyKey: "old",
		}),
	).rejects.toThrow("Revision");
	await saveAgentState({
		...state("guard", "guard-session"),
		agentPaused: true,
	});
	await expect(
		queueAgentCommand({
			...base,
			sessionId: "guard-session",
			expectedRevision: "revision-one",
			idempotencyKey: "paused",
		}),
	).rejects.toThrow("paused");
});
test("concurrent retries queue once; altered key inputs fail; atomic delivery", async () => {
	await saveAgentState(state("retry", "retry-session"));
	const input = {
		projectId: "retry",
		sessionId: "retry-session",
		expectedRevision: "revision-one",
		idempotencyKey: "batch-one",
		kind: "edit_batch" as const,
		payload: { operations: [] },
	};
	const commands = await Promise.all(
		Array.from({ length: 6 }, () => queueAgentCommand(input)),
	);
	expect(new Set(commands.map((c) => c.id)).size).toBe(1);
	await expect(
		queueAgentCommand({ ...input, payload: { dryRun: true } }),
	).rejects.toThrow("different");
	expect(
		await takeAgentCommand({ projectId: "retry", sessionId: "wrong" }),
	).toBeNull();
	const deliveries = await Promise.all(
		Array.from({ length: 6 }, () =>
			takeAgentCommand({ projectId: "retry", sessionId: "retry-session" }),
		),
	);
	expect(deliveries.filter(Boolean).length).toBe(1);
	await saveAgentState({
		...state("retry", "retry-session"),
		revision: "new-revision",
	});
	expect((await queueAgentCommand(input)).id).toBe(commands[0]?.id);
});
test("progressive inspection defaults compact and bounds pages", () => {
	const snapshot = state("inspect");
	expect(presentAgentState({ state: snapshot })).not.toHaveProperty("media");
	expect(presentAgentState({ state: snapshot })).not.toHaveProperty(
		"activeScene.tracks",
	);
	expect(
		presentAgentState({
			state: snapshot,
			query: new URLSearchParams({ detail: "full" }),
		}),
	).toEqual(snapshot);
	expect(() =>
		presentAgentState({
			state: snapshot,
			query: new URLSearchParams({ detail: "media", limit: "1000" }),
		}),
	).toThrow();
});
