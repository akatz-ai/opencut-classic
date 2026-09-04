export class ExportOperationTimeoutError extends Error {
	readonly operation: string;
	readonly timeoutMs: number;

	constructor({
		operation,
		timeoutMs,
	}: {
		operation: string;
		timeoutMs: number;
	}) {
		super(
			`${operation} stopped responding after ${Math.round(timeoutMs / 1000)}s`,
		);
		this.name = "ExportOperationTimeoutError";
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}

export class ExportOperationCancelledError extends Error {
	readonly operation: string;

	constructor({ operation }: { operation: string }) {
		super(`${operation} was cancelled`);
		this.name = "ExportOperationCancelledError";
		this.operation = operation;
	}
}

export async function runExportOperation<T>({
	operation,
	timeoutMs,
	task,
	onTimeout,
	isCancelled,
}: {
	operation: string;
	timeoutMs: number;
	task: () => Promise<T>;
	onTimeout?: () => void;
	isCancelled?: () => boolean;
}): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let cancellationId: ReturnType<typeof setInterval> | null = null;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			onTimeout?.();
			reject(new ExportOperationTimeoutError({ operation, timeoutMs }));
		}, timeoutMs);
	});
	const cancellation = new Promise<never>((_resolve, reject) => {
		if (!isCancelled) return;
		cancellationId = setInterval(() => {
			if (isCancelled()) {
				reject(new ExportOperationCancelledError({ operation }));
			}
		}, 100);
	});
	try {
		return await Promise.race([
			Promise.resolve().then(task),
			timeout,
			cancellation,
		]);
	} finally {
		if (timeoutId !== null) clearTimeout(timeoutId);
		if (cancellationId !== null) clearInterval(cancellationId);
	}
}

export async function settleExportCleanup({
	task,
	timeoutMs = 5_000,
}: {
	task: () => Promise<unknown>;
	timeoutMs?: number;
}): Promise<boolean> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<false>((resolve) => {
		timeoutId = setTimeout(() => resolve(false), timeoutMs);
	});
	try {
		return await Promise.race([
			Promise.resolve()
				.then(task)
				.then(() => true)
				.catch(() => false),
			timeout,
		]);
	} finally {
		if (timeoutId !== null) clearTimeout(timeoutId);
	}
}

export async function yieldToBrowser(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
