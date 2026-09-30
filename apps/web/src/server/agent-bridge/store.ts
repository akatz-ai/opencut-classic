import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
	AgentBridgeCommand,
	AgentBridgeCommandResult,
	AgentCommandKind,
	AgentProjectSnapshot,
} from "@/agent-bridge/types";
import { readWebStream } from "@/server/native-media/streams";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;

function bridgeRoot(): string {
	return (
		process.env.OPENCUT_AGENT_BRIDGE_DIR ??
		join(tmpdir(), `opencut-agent-bridge-${process.getuid?.() ?? "local"}`)
	);
}

function validateId(id: string): string {
	if (!SAFE_ID.test(id)) throw new Error("Invalid agent bridge identifier");
	return id;
}

async function writeJsonAtomic({
	path,
	value,
}: {
	path: string;
	value: unknown;
}): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, path);
}

export async function saveAgentState(
	snapshot: AgentProjectSnapshot,
): Promise<void> {
	const projectId = validateId(snapshot.project.id);
	if (!snapshot.sessionId) return; // An older editor must be refreshed before agent access.
	await writeJsonAtomic({
		path: join(
			bridgeRoot(),
			"sessions",
			`${validateId(snapshot.sessionId)}.json`,
		),
		value: {
			...snapshot,
			project: { ...snapshot.project, id: projectId },
			receivedAt: new Date().toISOString(),
		},
	});
}

export async function readAgentState({
	projectId,
	sessionId,
}: {
	projectId: string;
	sessionId?: string;
}): Promise<AgentProjectSnapshot | null> {
	validateId(projectId);
	if (sessionId) validateId(sessionId);
	const matches = (await listAgentStates()).filter(
		(s) =>
			s.project.id === projectId && (!sessionId || s.sessionId === sessionId),
	);
	if (matches.length > 1)
		throw new Error(
			"Multiple live windows for this project; specify sessionId",
		);
	return matches[0] ?? null;
}

export async function listAgentStates(): Promise<AgentProjectSnapshot[]> {
	const directory = join(bridgeRoot(), "sessions");
	try {
		const names = await readdir(directory);
		const states = await Promise.all(
			names
				.filter((name) => name.endsWith(".json"))
				.map(
					async (name) =>
						// Session files are written by saveAgentState.
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
						JSON.parse(
							await readFile(join(directory, name), "utf8"),
						) as AgentProjectSnapshot,
				),
		);
		return states.filter(
			(state) =>
				state.receivedAt && Date.now() - Date.parse(state.receivedAt) < 10_000,
		);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

export async function queueAgentCommand({
	projectId,
	kind,
	payload,
	expectedRevision,
	sessionId,
	idempotencyKey,
}: {
	projectId: string;
	kind: AgentCommandKind;
	payload: Record<string, unknown>;
	expectedRevision?: string;
	sessionId?: string;
	idempotencyKey?: string;
}): Promise<AgentBridgeCommand> {
	validateId(projectId);
	if (
		kind === "edit_batch" &&
		(!sessionId || !idempotencyKey || !expectedRevision)
	)
		throw new Error(
			"edit_batch requires sessionId, expectedRevision, and idempotencyKey",
		);
	if (kind === "apply_cut_plan" && !expectedRevision)
		throw new Error("Cut plans require expectedRevision");
	if (idempotencyKey) validateId(idempotencyKey);
	const id = idempotencyKey
		? createHash("sha256")
				.update(`${projectId}:${idempotencyKey}`)
				.digest("hex")
		: randomUUID();
	const path = commandPath({ projectId, id });
	const fingerprint = JSON.stringify({
		kind,
		payload,
		expectedRevision,
		sessionId,
	});
	const existing = async () => {
		// Command files are written only by this queue.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const old = JSON.parse(
			await readFile(path, "utf8"),
		) as AgentBridgeCommand & { fingerprint: string };
		if (old.fingerprint !== fingerprint)
			throw new Error(
				"Idempotency key already used with different command inputs",
			);
		return old;
	};
	if (idempotencyKey) {
		try {
			return await existing();
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
	const state = await readAgentState({ projectId, sessionId });
	if (!state)
		throw new Error("No fresh editor session; open or refresh the project");
	if (state.agentPaused)
		throw new Error("Agent commands are paused in this editor");
	if (expectedRevision && expectedRevision !== state.revision)
		throw new Error("Revision mismatch; inspect and re-plan");
	const command: AgentBridgeCommand = {
		id,
		sessionId: state.sessionId,
		expiresAt: new Date(Date.now() + 30_000).toISOString(),
		projectId: validateId(projectId),
		kind,
		payload,
		expectedRevision,
		createdAt: new Date().toISOString(),
	};
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify({ ...command, fingerprint }), {
		mode: 0o600,
	});
	try {
		try {
			await link(temporary, path);
		} catch (error) {
			if (
				typeof error === "object" &&
				error &&
				"code" in error &&
				error.code === "EEXIST"
			)
				return await existing();
			throw error;
		}
	} finally {
		await unlink(temporary);
	}
	return command;
}

export async function takeAgentCommand({
	projectId,
	sessionId,
}: {
	projectId: string;
	sessionId?: string;
}): Promise<AgentBridgeCommand | null> {
	if (!sessionId) return null;
	validateId(sessionId);
	const directory = join(bridgeRoot(), "commands", validateId(projectId));
	try {
		const files = (await readdir(directory)).filter((name) =>
			name.endsWith(".json"),
		);
		for (const name of files.sort()) {
			const path = join(directory, name);
			// Command files are created only by queueAgentCommand.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const command = JSON.parse(
				await readFile(path, "utf8"),
			) as AgentBridgeCommand;
			if (command.deliveredAt) continue;
			if (command.sessionId !== sessionId) continue;
			try {
				await writeFile(`${path}.claim`, sessionId, {
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				if (
					typeof error === "object" &&
					error &&
					"code" in error &&
					error.code === "EEXIST"
				)
					continue;
				throw error;
			}
			if (!command.expiresAt || Date.now() > Date.parse(command.expiresAt)) {
				await saveAgentCommandResult({
					projectId,
					result: {
						commandId: command.id,
						success: false,
						completedAt: new Date().toISOString(),
						error: "Command expired before delivery",
					},
				});
				continue;
			}
			const delivered = { ...command, deliveredAt: new Date().toISOString() };
			await writeJsonAtomic({ path, value: delivered });
			return delivered;
		}
		return null;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

export async function saveAgentCommandResult({
	projectId,
	result,
}: {
	projectId: string;
	result: AgentBridgeCommandResult;
}): Promise<void> {
	validateId(result.commandId);
	await writeJsonAtomic({
		path: join(
			bridgeRoot(),
			"results",
			validateId(projectId),
			`${result.commandId}.json`,
		),
		value: result,
	});
}

export async function readAgentCommandResult({
	projectId,
	commandId,
}: {
	projectId: string;
	commandId: string;
}): Promise<AgentBridgeCommandResult | null> {
	try {
		// Result files are created only by saveAgentCommandResult.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return JSON.parse(
			await readFile(
				join(
					bridgeRoot(),
					"results",
					validateId(projectId),
					`${validateId(commandId)}.json`,
				),
				"utf8",
			),
		) as AgentBridgeCommandResult;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

export async function saveAgentArtifact({
	projectId,
	mediaId,
	filename,
	body,
}: {
	projectId: string;
	mediaId: string;
	filename: string;
	body: ReadableStream<Uint8Array>;
}): Promise<{ artifactId: string; path: string }> {
	const artifactId = randomUUID();
	const safeFilename = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
	const directory = join(
		bridgeRoot(),
		"artifacts",
		validateId(projectId),
		artifactId,
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${validateId(mediaId)}-${safeFilename}`);
	await pipeline(
		Readable.from(readWebStream(body)),
		createWriteStream(path, { mode: 0o600 }),
	);
	return { artifactId, path };
}

function commandPath(
	command: Pick<AgentBridgeCommand, "projectId" | "id">,
): string {
	return join(
		bridgeRoot(),
		"commands",
		command.projectId,
		`${command.id}.json`,
	);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
