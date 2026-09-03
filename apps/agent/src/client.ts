export type AgentCommandKind = "stage_media" | "apply_cut_plan";

const DEFAULT_BASE_URL = "http://127.0.0.1:3003";

function baseUrl(): string {
	return process.env.OPENCUT_AGENT_URL ?? DEFAULT_BASE_URL;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(`${baseUrl()}${path}`, init);
	if (response.ok || response.status === 202) return response;
	let message = `${response.status} ${response.statusText}`;
	try {
		const body: unknown = await response.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "string"
		) {
			message = body.error;
		}
	} catch {}
	throw new Error(message);
}

export async function listProjects(): Promise<unknown> {
	return await (await request("/api/agent-bridge/state")).json();
}

export async function inspectProject(projectId: string): Promise<unknown> {
	return await (
		await request(
			`/api/agent-bridge/state?projectId=${encodeURIComponent(projectId)}`,
		)
	).json();
}

export async function runCommand({
	projectId,
	kind,
	payload,
	expectedRevision,
	timeoutMs = 120_000,
}: {
	projectId: string;
	kind: AgentCommandKind;
	payload: Record<string, unknown>;
	expectedRevision?: string;
	timeoutMs?: number;
}): Promise<unknown> {
	const queued: unknown = await (
		await request("/api/agent-bridge/commands", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ projectId, kind, payload, expectedRevision }),
		})
	).json();
	const commandId = readCommandId(queued);
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const response = await request(
			`/api/agent-bridge/commands/${commandId}?projectId=${encodeURIComponent(projectId)}`,
		);
		if (response.status !== 202) return await response.json();
		await Bun.sleep(250);
	}
	throw new Error(`Agent command ${commandId} timed out after ${timeoutMs}ms`);
}

function readCommandId(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		"command" in value &&
		typeof value.command === "object" &&
		value.command !== null &&
		"id" in value.command &&
		typeof value.command.id === "string"
	) {
		return value.command.id;
	}
	throw new Error("Bridge did not return a command ID");
}
