import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, validateWorkItem, toTimestamp, toPerson, workItemSchema, ValidationError } from '../src/index.js';

const now = () => new Date('2026-11-24T09:00:00Z');
const base = { source: 'orders', externalId: 'SO-1', title: 'Restock shrink wrap' };

describe('normalize', () => {
  test('fills defaults and builds the id from source and externalId', () => {
    assert.deepEqual(normalize(base, { now }), {
      id: 'orders:SO-1',
      source: 'orders',
      externalId: 'SO-1',
      kind: 'task',
      title: 'Restock shrink wrap',
      status: 'open',
      priority: 'normal',
      labels: [],
      createdAt: '2026-11-24T09:00:00.000Z',
      updatedAt: '2026-11-24T09:00:00.000Z',
      receivedAt: '2026-11-24T09:00:00.000Z',
    });
  });

  test('the result always passes the published schema', () => {
    assert.throws(() => normalize({ ...base, amount: '12.50' }, { now }),
      (err) => err.errors[0].path === '/amount/currency', 'an amount without a currency is refused');
    const ok = normalize({ ...base, amount: { value: '12.50', currency: 'usd' }, requester: 'Dana <Dana@corvane.example>' }, { now });
    assert.deepEqual(validateWorkItem(ok), { valid: true, errors: [] });
  });

  test('the shipped schema file and the exported schema are the same', () => {
    const file = JSON.parse(readFileSync(new URL('../schemas/work-item.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(workItemSchema, file);
  });

  test('cleans text: trims, collapses title whitespace, normalises body line breaks', () => {
    const item = normalize({ ...base, title: '  Two\n words\t here ', body: 'a\r\nb\rc  ' }, { now });
    assert.equal(item.title, 'Two words here');
    assert.equal(item.body, 'a\nb\nc');
  });

  test('truncates an over-long title with an ellipsis instead of refusing it', () => {
    const item = normalize({ ...base, title: 'x'.repeat(500) }, { now });
    assert.equal([...item.title].length, 300);
    assert.ok(item.title.endsWith('…'));
  });

  test('lower-cases source and normalises enum spelling', () => {
    const item = normalize({ ...base, source: 'Orders', status: 'In Progress', priority: 'HIGH' }, { now });
    assert.equal(item.id, 'orders:SO-1');
    assert.equal(item.status, 'in_progress');
    assert.equal(item.priority, 'high');
  });

  test('numeric external ids become strings', () => {
    assert.equal(normalize({ ...base, externalId: 4821 }, { now }).id, 'orders:4821');
  });

  test('dedupes labels case-insensitively, keeping first spelling and order', () => {
    const item = normalize({ ...base, labels: ['Billing', ' billing', '', null, { name: 'urgent' }, 'Address'] }, { now });
    assert.deepEqual(item.labels, ['Billing', 'urgent', 'Address']);
    assert.deepEqual(normalize({ ...base, labels: 'a, b;c' }, { now }).labels, ['a', 'b', 'c']);
  });

  test('amount strings with separators and symbols become numbers; currency is upper-cased', () => {
    const item = normalize({ ...base, amount: { value: '$1,240.50', currency: 'usd' } }, { now });
    assert.deepEqual(item.amount, { value: 1240.5, currency: 'USD' });
  });

  test('an unreadable amount is reported, not turned into zero', () => {
    assert.throws(() => normalize({ ...base, amount: { value: 'about ten', currency: 'USD' } }, { now }),
      (err) => err.errors[0].path === '/amount/value');
  });

  test('createdAt defaults to receivedAt, updatedAt to createdAt', () => {
    const item = normalize({ ...base, receivedAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-19' }, { now });
    assert.equal(item.createdAt, '2026-11-19T00:00:00.000Z');
    assert.equal(item.updatedAt, '2026-11-19T00:00:00.000Z');
    assert.equal(item.receivedAt, '2026-11-20T10:00:00.000Z');
  });

  test('reports every problem at once with JSON Pointer paths', () => {
    assert.throws(
      () => normalize({ source: 'Bad Source!', title: '', status: 'shipped', url: 'not a url',
        requester: { email: 'nope@' } }, { now }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.deepEqual(err.errors.map((e) => e.path).sort(),
          ['/externalId', '/id', '/requester/email', '/source', '/status', '/title', '/url'].sort());
        return true;
      },
    );
  });

  test('refuses fields that are not part of a WorkItem', () => {
    assert.throws(() => normalize({ ...base, owner: 'Dana' }, { now }), (err) => err.errors[0].path === '/owner');
  });

  test('refuses a non-object', () => {
    assert.throws(() => normalize(null), ValidationError);
    assert.throws(() => normalize([base]), ValidationError);
  });

  test('the id cannot be overridden by the input', () => {
    assert.equal(normalize({ ...base, id: 'something-else' }, { now }).id, 'orders:SO-1');
  });

  test('attributes keep scalars, sort keys and drop undefined values', () => {
    const item = normalize({ ...base, attributes: { z: 1, a: 'x', skip: undefined, flag: false, none: null } }, { now });
    assert.deepEqual(Object.keys(item.attributes), ['a', 'flag', 'none', 'z']);
    assert.throws(() => normalize({ ...base, attributes: { nested: { a: 1 } } }, { now }),
      (err) => err.errors[0].path === '/attributes/nested');
  });
});

describe('toTimestamp', () => {
  test('reads ISO strings, offsets and naive values as UTC', () => {
    assert.equal(toTimestamp('2026-11-22T09:41:00+01:00'), '2026-11-22T08:41:00.000Z');
    assert.equal(toTimestamp('2026-11-22T09:41:00+0100'), '2026-11-22T08:41:00.000Z');
    assert.equal(toTimestamp('2026-11-23 16:02:10'), '2026-11-23T16:02:10.000Z');
    assert.equal(toTimestamp('2026-11-23T16:02'), '2026-11-23T16:02:00.000Z');
    assert.equal(toTimestamp('2026-11-23'), '2026-11-23T00:00:00.000Z');
  });

  test('reads epoch seconds and milliseconds', () => {
    assert.equal(toTimestamp(1795452300), '2026-11-23T16:45:00.000Z');
    assert.equal(toTimestamp(1795452300000), '2026-11-23T16:45:00.000Z');
    assert.equal(toTimestamp(new Date(0)), '1970-01-01T00:00:00.000Z');
  });

  test('returns unreadable values unchanged so validation can report them', () => {
    for (const v of ['2026-02-30', 'yesterday', '11/23/2026', '1', '2026-11-23T25:00']) {
      assert.equal(toTimestamp(v), v, v);
    }
    const bad = new Date('nope');
    assert.equal(toTimestamp(bad), bad);
  });
});

describe('toPerson', () => {
  test('reads the common shapes', () => {
    assert.deepEqual(toPerson('Dana <Dana@Corvane.example>'), { name: 'Dana', email: 'dana@corvane.example' });
    assert.deepEqual(toPerson('"Dana" <dana@corvane.example>'), { name: 'Dana', email: 'dana@corvane.example' });
    assert.deepEqual(toPerson('dana@corvane.example'), { email: 'dana@corvane.example' });
    assert.deepEqual(toPerson('Dana'), { name: 'Dana' });
    assert.deepEqual(toPerson({ name: ' Dana ', email: '' }), { name: 'Dana' });
  });

  test('returns undefined when there is nobody', () => {
    for (const v of [undefined, null, '', '   ', {}, { name: '', email: null }]) assert.equal(toPerson(v), undefined);
  });
});
