import { describe, expect, test } from "bun:test";
import { LruCache } from "@/services/cache/lru-cache";

describe("LruCache", () => {
	test("evicts the least recently used entry", () => {
		const evicted: string[] = [];
		const cache = new LruCache<string, number>({
			maxEntries: 2,
			onEvict: (key) => evicted.push(key),
		});

		cache.set({ key: "a", value: 1 });
		cache.set({ key: "b", value: 2 });
		expect(cache.get("a")).toBe(1);
		cache.set({ key: "c", value: 3 });

		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
		expect(cache.has("c")).toBe(true);
		expect(evicted).toEqual(["b"]);
	});

	test("disposes entries removed explicitly or by clear", () => {
		const evicted: string[] = [];
		const cache = new LruCache<string, number>({
			maxEntries: 3,
			onEvict: (key) => evicted.push(key),
		});

		cache.set({ key: "a", value: 1 });
		cache.set({ key: "b", value: 2 });
		cache.delete("a");
		cache.clear();

		expect(evicted).toEqual(["a", "b"]);
		expect(cache.size).toBe(0);
	});

	test("rejects invalid cache sizes", () => {
		expect(() => new LruCache({ maxEntries: 0 })).toThrow("positive integer");
	});
});
