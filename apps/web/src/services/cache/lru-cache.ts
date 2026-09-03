export class LruCache<TKey, TValue> {
	private entries = new Map<TKey, TValue>();
	private readonly maxEntries: number;
	private readonly onEvict?: (key: TKey, value: TValue) => void;

	constructor({
		maxEntries,
		onEvict,
	}: {
		maxEntries: number;
		onEvict?: (key: TKey, value: TValue) => void;
	}) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new Error("LRU cache size must be a positive integer");
		}
		this.maxEntries = maxEntries;
		this.onEvict = onEvict;
	}

	get size(): number {
		return this.entries.size;
	}

	has(key: TKey): boolean {
		return this.entries.has(key);
	}

	get(key: TKey): TValue | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;

		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set({ key, value }: { key: TKey; value: TValue }): void {
		const previous = this.entries.get(key);
		if (previous !== undefined) {
			this.entries.delete(key);
			if (previous !== value) {
				this.onEvict?.(key, previous);
			}
		}

		this.entries.set(key, value);
		while (this.entries.size > this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.delete(oldestKey);
		}
	}

	delete(key: TKey): boolean {
		const value = this.entries.get(key);
		if (value === undefined) return false;

		this.entries.delete(key);
		this.onEvict?.(key, value);
		return true;
	}

	clear(): void {
		for (const [key, value] of this.entries) {
			this.onEvict?.(key, value);
		}
		this.entries.clear();
	}

	values(): IterableIterator<TValue> {
		return this.entries.values();
	}

	keys(): IterableIterator<TKey> {
		return this.entries.keys();
	}
}
