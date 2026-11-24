import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTtlStore, createDeduper, dedupeKey } from '../src/index.js';

function clock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

describe('MemoryTtlStore', () => {
  test('stores values until they expire', () => {
    const now = clock();
    const store = new MemoryTtlStore({ now });
    store.set('k', 'v', 1000);
    assert.equal(store.get('k'), 'v');
    now.advance(999);
    assert.equal(store.has('k'), true);
    now.advance(1);
    assert.equal(store.get('k'), undefined);
    assert.equal(store.has('k'), false);
  });

  test('setIfAbsent is true once, then false until expiry', () => {
    const now = clock();
    const store = new MemoryTtlStore({ now });
    assert.equal(store.setIfAbsent('k', 1, 50), true);
    assert.equal(store.setIfAbsent('k', 2, 50), false);
    assert.equal(store.get('k'), 1);
    now.advance(50);
    assert.equal(store.setIfAbsent('k', 3, 50), true);
    assert.equal(store.get('k'), 3);
  });

  test('size and prune count only live entries', () => {
    const now = clock();
    const store = new MemoryTtlStore({ now });
    store.set('a', 1, 10);
    store.set('b', 1, 100);
    now.advance(10);
    assert.equal(store.size, 1);
    assert.equal(store.prune(), 0);
  });

  test('maxEntries drops expired entries first, then the oldest', () => {
    const now = clock();
    const store = new MemoryTtlStore({ now, maxEntries: 2 });
    store.set('a', 1, 1000);
    store.set('b', 1, 5);
    now.advance(5);
    store.set('c', 1, 1000); // b has expired and makes room
    assert.equal(store.has('a'), true);
    store.set('d', 1, 1000); // full: a is the oldest
    assert.equal(store.has('a'), false);
    assert.deepEqual(['c', 'd'].map((k) => store.has(k)), [true, true]);
  });

  test('re-setting a key refreshes its place in the eviction order', () => {
    const store = new MemoryTtlStore({ now: clock(), maxEntries: 2 });
    store.set('a', 1, 1000);
    store.set('b', 1, 1000);
    store.set('a', 2, 1000);
    store.set('c', 1, 1000);
    assert.equal(store.has('a'), true);
    assert.equal(store.has('b'), false);
  });

  test('delete and invalid arguments', () => {
    const store = new MemoryTtlStore();
    store.set('k', 1, 10);
    assert.equal(store.delete('k'), true);
    assert.equal(store.delete('k'), false);
    assert.throws(() => store.set('k', 1, 0), TypeError);
    assert.throws(() => new MemoryTtlStore({ maxEntries: 0 }), TypeError);
  });
});

describe('dedupeKey', () => {
  test('encodes parts so different pairs never share a key', () => {
    assert.notEqual(dedupeKey('a:b', 'c'), dedupeKey('a', 'b:c'));
    assert.equal(dedupeKey('github', 'org/repo#1'), 'dedupe:github:org%2Frepo%231');
    assert.equal(dedupeKey('crm', 42, 'imports'), 'imports:crm:42');
  });

  test('requires both parts', () => {
    assert.throws(() => dedupeKey('', 'x'), TypeError);
    assert.throws(() => dedupeKey('crm', undefined), TypeError);
    assert.throws(() => dedupeKey(null, 'x'), TypeError);
  });
});

describe('createDeduper', () => {
  const item = { source: 'helpdesk', externalId: '4821' };

  test('firstSeen is true once per pair within the TTL', async () => {
    const now = clock();
    const deduper = createDeduper({ store: new MemoryTtlStore({ now }), ttlMs: 1000 });
    assert.equal(await deduper.firstSeen(item), true);
    assert.equal(await deduper.firstSeen({ ...item }), false);
    assert.equal(await deduper.firstSeen({ source: 'crm', externalId: '4821' }), true, 'same id, other source');
    now.advance(1000);
    assert.equal(await deduper.firstSeen(item), true, 'seen again after the TTL');
  });

  test('run handles a pair once and skips duplicates', async () => {
    const deduper = createDeduper();
    let calls = 0;
    const handler = async () => { calls += 1; return 'saved'; };
    assert.deepEqual(await deduper.run(item, handler), { status: 'processed', result: 'saved' });
    assert.deepEqual(await deduper.run(item, handler), { status: 'duplicate' });
    assert.equal(calls, 1);
  });

  test('a failed handler is forgotten so the retry is processed', async () => {
    const deduper = createDeduper();
    await assert.rejects(deduper.run(item, async () => { throw new Error('database down'); }), /database down/);
    assert.equal((await deduper.run(item, async () => 'ok')).status, 'processed');
  });

  test('concurrent deliveries of the same pair run the handler once', async () => {
    const deduper = createDeduper();
    let calls = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => deduper.run(item, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    })));
    assert.equal(calls, 1);
    assert.equal(results.filter((r) => r.status === 'duplicate').length, 4);
  });

  test('works with an asynchronous shared store', async () => {
    const map = new Map();
    const store = {
      async setIfAbsent(key, value) { if (map.has(key)) return false; map.set(key, value); return true; },
      async get(key) { return map.get(key); },
      async delete(key) { return map.delete(key); },
    };
    const deduper = createDeduper({ store, namespace: 'inbound' });
    assert.equal(await deduper.firstSeen(item), true);
    assert.equal(await deduper.firstSeen(item), false);
    assert.deepEqual([...map.keys()], ['inbound:helpdesk:4821']);
    assert.equal(await deduper.forget(item), true);
    assert.equal(await deduper.firstSeen(item), true);
  });

  test('refuses items without a source or externalId, and bad TTLs', async () => {
    const deduper = createDeduper();
    await assert.rejects(deduper.firstSeen({ source: 'crm' }), TypeError);
    assert.throws(() => createDeduper({ ttlMs: -1 }), TypeError);
  });
});
