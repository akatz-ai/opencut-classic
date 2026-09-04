import { describe, expect, test } from "bun:test";
import {
	ExportOperationCancelledError,
	ExportOperationTimeoutError,
	runExportOperation,
	settleExportCleanup,
} from "@/export/watchdog";

describe("export watchdog", () => {
	test("returns a completed operation", async () => {
		await expect(
			runExportOperation({
				operation: "frame render",
				timeoutMs: 100,
				task: async () => 42,
			}),
		).resolves.toBe(42);
	});

	test("rejects a stalled operation and invokes its timeout hook", async () => {
		let timedOut = false;
		const operation = runExportOperation({
			operation: "frame render",
			timeoutMs: 5,
			task: () => new Promise<number>(() => {}),
			onTimeout: () => {
				timedOut = true;
			},
		});
		await expect(operation).rejects.toBeInstanceOf(ExportOperationTimeoutError);
		expect(timedOut).toBe(true);
	});

	test("bounds cleanup that never settles", async () => {
		await expect(
			settleExportCleanup({
				timeoutMs: 5,
				task: () => new Promise<void>(() => {}),
			}),
		).resolves.toBe(false);
	});

	test("interrupts a stalled operation after cancellation", async () => {
		let cancelled = false;
		const operation = runExportOperation({
			operation: "frame render",
			timeoutMs: 1_000,
			task: () => new Promise<number>(() => {}),
			isCancelled: () => cancelled,
		});
		cancelled = true;
		await expect(operation).rejects.toBeInstanceOf(
			ExportOperationCancelledError,
		);
	});
});
