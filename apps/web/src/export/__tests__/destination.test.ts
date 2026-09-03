import { afterEach, describe, expect, test } from "bun:test";
import { selectExportDestination } from "@/export";

const originalWindow = globalThis.window;

function setWindow(value: unknown) {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value,
		writable: true,
	});
}

afterEach(() => {
	setWindow(originalWindow);
});

describe("selectExportDestination", () => {
	test("returns unavailable when the save-file API is missing", async () => {
		setWindow({});

		const result = await selectExportDestination({
			filename: "project.mp4",
			mimeType: "video/mp4",
			extension: ".mp4",
		});

		expect(result).toEqual({ status: "unavailable" });
	});

	test("returns a writable destination selected by the user", async () => {
		const writable = new WritableStream();
		let receivedOptions: unknown;
		const pickerWindow = {
			showSaveFilePicker: async (options: unknown) => {
				receivedOptions = options;
				return {
					createWritable: async () => writable,
				};
			},
		};
		setWindow(pickerWindow);

		const result = await selectExportDestination({
			filename: "project.mp4",
			mimeType: "video/mp4",
			extension: ".mp4",
		});

		expect(result.status).toBe("selected");
		if (result.status === "selected") {
			expect(result.destination.writable).toBe(writable);
		}
		expect(receivedOptions).toEqual({
			suggestedName: "project.mp4",
			types: [
				{
					description: "MP4 video",
					accept: { "video/mp4": [".mp4"] },
				},
			],
		});
	});

	test("treats closing the picker as cancellation", async () => {
		setWindow({
			showSaveFilePicker: async () => {
				throw new DOMException("cancelled", "AbortError");
			},
		});

		const result = await selectExportDestination({
			filename: "project.webm",
			mimeType: "video/webm",
			extension: ".webm",
		});

		expect(result).toEqual({ status: "cancelled" });
	});
});
