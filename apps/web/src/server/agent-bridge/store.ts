import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value));
	await rename(temporary, path);
}

export async function saveAgentState(
	snapshot: AgentProjectSnapshot,
): Promise<void> {
	const projectId = validateId(snapshot.project.id);
	await writeJsonAtomic({
		path: join(bridgeRoot(), "state", `${projectId}.json`),
		value: snapshot,
	});
}

export async function readAgentState({
	projectId,
}: {
	projectId: string;
}): Promise<AgentProjectSnapshot | null> {
	try {
		// Files in this directory are written only by saveAgentState.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return JSON.parse(
			await readFile(
				join(bridgeRoot(), "state", `${validateId(projectId)}.json`),
				"utf8",
			),
		) as AgentProjectSnapshot;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

export async function listAgentStates(): Promise<AgentProjectSnapshot[]> {
	const directory = join(bridgeRoot(), "state");
	try {
		const names = await readdir(directory);
		const states = await Promise.all(
			names
				.filter((name) => name.endsWith(".json"))
				.map((name) => readAgentState({ projectId: name.slice(0, -5) })),
		);
		return states.filter((state): state is AgentProjectSnapshot => state !== null);
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
}: {
	projectId: string;
	kind: AgentCommandKind;
	payload: Record<string, unknown>;
	expectedRevision?: string;
}): Promise<AgentBridgeCommand> {
	const command: AgentBridgeCommand = {
		id: randomUUID(),
		projectId: validateId(projectId),
		kind,
		payload,
		expectedRevision,
		createdAt: new Date().toISOString(),
	};
	await writeJsonAtomic({ path: commandPath(command), value: command });
	return command;
}

export async function takeAgentCommand({
	projectId,
}: {
	projectId: string;
}): Promise<AgentBridgeCommand | null> {
	const directory = join(bridgeRoot(), "commands", validateId(projectId));
	try {
		const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
		for (const name of files.sort()) {
			const path = join(directory, name);
			// Command files are created only by queueAgentCommand.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const command = JSON.parse(await readFile(path, "utf8")) as AgentBridgeCommand;
			if (command.deliveredAt) continue;
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
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${validateId(mediaId)}-${safeFilename}`);
	await pipeline(Readable.from(readWebStream(body)), createWriteStream(path));
	return { artifactId, path };
}

function commandPath(command: AgentBridgeCommand): string {
	return join(
		bridgeRoot(),
		"commands",
		command.projectId,
		`${command.createdAt}-${command.id}.json`.replaceAll(":", "-"),
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
