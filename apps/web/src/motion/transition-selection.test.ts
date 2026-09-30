import { beforeEach, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SelectionManager } from "@/core/managers/selection-manager";
import type {
	ElementRef,
	TimelineElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime } from "@/wasm";
import {
	getSelectedTransition,
	removeSelectedTransition,
	selectTransition,
	updateTransition,
	useTransitionSelectionStore,
} from "./transition-selection";
import { isTransitionKind } from "./catalog";

const target = { trackId: "main", elementId: "incoming", edge: "cut" as const };
const ticks = (value: number) => mediaTime({ ticks: value });
const transition = {
	kind: "fade" as const,
	duration: 10,
	easing: "linear" as const,
};

function fixture() {
	const track: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: ["outgoing", "incoming"].map(
			(id, i): VideoElement => ({
				id,
				name: id,
				type: "video",
				mediaId: id,
				params: {},
				startTime: ticks(i * 40),
				duration: ticks(40),
				trimStart: ticks(0),
				trimEnd: ticks(20),
				sourceDuration: ticks(60),
			}),
		),
	};
	let writes = 0;
	// Only the manager surface used by the UI command adapter is needed here.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Isolated manager fixture; constructing EditorCore would start browser storage services.
	const editor = {
		timeline: {
			getElementsWithTracks({ elements }: { elements: ElementRef[] }) {
				return elements.flatMap((ref) => {
					const element = track.elements.find(
						(e) => ref.trackId === track.id && ref.elementId === e.id,
					);
					return element ? [{ element, track }] : [];
				});
			},
			updateElements({
				updates,
			}: {
				updates: (ElementRef & { patch: Partial<TimelineElement> })[];
			}) {
				writes++;
				for (const update of updates) {
					const element = track.elements.find(
						(e) => e.id === update.elementId,
					)!;
					Object.assign(element, update.patch);
				}
			},
		},
	} as unknown as EditorCore;
	Object.defineProperty(editor, "selection", {
		value: new SelectionManager(editor),
	});
	return { editor, track, writes: () => writes };
}

beforeEach(() =>
	useTransitionSelectionStore.setState({ target: null, selection: null }),
);

test("transition selection expires when the clip selection is replaced", () => {
	const { editor } = fixture();
	selectTransition({ editor, target });
	expect(getSelectedTransition(editor)).toEqual(target);
	editor.selection.setSelectedElements({
		elements: [{ trackId: "main", elementId: "incoming" }],
	});
	expect(getSelectedTransition(editor)).toBeNull();
	expect(removeSelectedTransition(editor)).toBe(false);
});

test("mask-point selection takes precedence over a stale transition target", () => {
	const { editor } = fixture();
	selectTransition({ editor, target });
	editor.selection.setSelectedMaskPoints({
		selection: { ...target, maskId: "mask", pointIds: ["point"] },
	});
	expect(getSelectedTransition(editor)).toBeNull();
});

test("removing a selected transition preserves both clips and the other edge", () => {
	const { editor, track, writes } = fixture();
	track.elements[1].motion = {
		enter: transition,
		exit: transition,
		fromPrevious: true,
	};
	selectTransition({ editor, target });
	expect(removeSelectedTransition(editor)).toBe(true);
	expect(track.elements).toHaveLength(2);
	expect(track.elements[1].motion).toEqual({
		exit: transition,
		fromPrevious: false,
	});
	expect(writes()).toBe(1);
	expect(getSelectedTransition(editor)).toBeNull();
	expect(editor.selection.getSelectedElements()).toEqual([]);
});

test("invalid source handles reject the entire edit before creating a command", () => {
	const { editor, track, writes } = fixture();
	track.elements[0].trimEnd = ticks(0);
	expect(() => updateTransition({ editor, target, transition })).toThrow();
	expect(writes()).toBe(0);
	expect(track.elements[1].motion).toBeUndefined();
});

test("a removed target never intercepts Delete", () => {
	const { editor, track } = fixture();
	selectTransition({ editor, target });
	track.elements = [];
	expect(removeSelectedTransition(editor)).toBe(false);
});

test("drag payloads only accept implemented transition kinds", () => {
	expect(isTransitionKind("slide-left")).toBe(true);
	expect(isTransitionKind("zoom-blur")).toBe(false);
	expect(isTransitionKind("__proto__")).toBe(false);
});
