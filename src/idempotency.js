/**
 * Idempotency for inbound events.
 *
 * Senders retry. A webhook that times out is delivered again, a CSV is
 * imported twice. The deduper remembers which (source, externalId) pairs it
 * has handled for a while, so the second delivery is recognised and skipped.
 *
 * Storage is behind a small interface so a shared store (Redis, a database
 * table with a unique key) can replace the in-memory one when several
 * processes receive events:
 *
 *   setIfAbsent(key, value, ttlMs) -> boolean | Promise<boolean>   // atomic
 *   get(key)                       -> value | undefined | Promise<…>
 *   delete(key)                    -> boolean | Promise<boolean>
 */

/** An in-memory TTL store. Per process; entries are lost on restart. */
export class MemoryTtlStore {
  #entries = new Map();
  #now;
  #maxEntries;

  /**
   * @param {{ now?: () => number, maxEntries?: number }} [options]
   *   `maxEntries` bounds memory: when full, the oldest entry is dropped.
   */
  constructor({ now = Date.now, maxEntries = 100_000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  #live(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key) {
    return this.#live(key)?.value;
  }

  has(key) {
    return this.#live(key) !== undefined;
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number');
    this.#entries.delete(key); // re-insert so Map order stays oldest-first
    if (this.#entries.size >= this.#maxEntries) this.prune();
    while (this.#entries.size >= this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  setIfAbsent(key, value, ttlMs) {
    if (this.#live(key)) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  /** Removes expired entries; returns how many were removed. */
  prune() {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of entries that have not expired. */
  get size() {
    this.prune();
    return this.#entries.size;
  }
}

/**
 * The key for a (source, externalId) pair. Each part is URI-encoded so
 * ("a:b", "c") and ("a", "b:c") can never collide.
 */
export function dedupeKey(source, externalId, namespace = 'dedupe') {
  for (const [name, value] of [['source', source], ['externalId', externalId]]) {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value) === '') {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }
  return `${namespace}:${encodeURIComponent(String(source))}:${encodeURIComponent(String(externalId))}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ store?: object, ttlMs?: number, namespace?: string }} [options]
 */
export function createDeduper({ store = new MemoryTtlStore(), ttlMs = DAY_MS, namespace = 'dedupe' } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number');
  const keyOf = (item) => dedupeKey(item?.source, item?.externalId, namespace);

  return {
    store,
    ttlMs,
    key: keyOf,

    /** True the first time a (source, externalId) pair is seen within the TTL. */
    async firstSeen(item) {
      return Boolean(await store.setIfAbsent(keyOf(item), Date.now(), ttlMs));
    },

    /** Forgets a pair, so its next delivery is handled again. */
    async forget(item) {
      return Boolean(await store.delete(keyOf(item)));
    },

    /**
     * Runs `handler(item)` once per pair. A duplicate is skipped. If the
     * handler throws, the pair is forgotten so the sender's retry is handled.
     */
    async run(item, handler) {
      if (!(await this.firstSeen(item))) return { status: 'duplicate' };
      try {
        return { status: 'processed', result: await handler(item) };
      } catch (err) {
        await this.forget(item);
        throw err;
      }
    },
  };
}
