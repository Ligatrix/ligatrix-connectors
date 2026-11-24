import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, validate, assertValid, isDateTime, isEmail, isUri, SchemaError, ValidationError,
} from '../src/index.js';

const paths = (result) => result.errors.map((e) => `${e.path} ${e.keyword}`);

describe('type', () => {
  test('accepts each JSON type and rejects the others', () => {
    const cases = [
      ['string', 'x', 1],
      ['number', 1.5, '1.5'],
      ['integer', 3, 3.1],
      ['boolean', false, 0],
      ['object', {}, []],
      ['array', [], {}],
      ['null', null, undefined],
    ];
    for (const [type, good, bad] of cases) {
      assert.equal(validate({ type }, good).valid, true, `${type} accepts ${JSON.stringify(good)}`);
      assert.equal(validate({ type }, bad).valid, false, `${type} rejects ${String(bad)}`);
    }
  });

  test('a list of types accepts any of them', () => {
    const schema = { type: ['string', 'null'] };
    assert.equal(validate(schema, null).valid, true);
    assert.equal(validate(schema, 'a').valid, true);
    const r = validate(schema, 4);
    assert.equal(r.errors[0].message, 'must be string or null, got number');
  });

  test('NaN and Infinity are not numbers', () => {
    assert.equal(validate({ type: 'number' }, Number.NaN).valid, false);
    assert.equal(validate({ type: 'number' }, Infinity).errors[0].params.actual, 'non-finite number');
  });

  test('a type failure stops further checks on that value', () => {
    const r = validate({ type: 'string', minLength: 3, pattern: '^a' }, 12);
    assert.deepEqual(paths(r), [' type']);
  });
});

describe('required, properties, additionalProperties', () => {
  const schema = {
    type: 'object',
    required: ['id', 'owner'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      owner: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string', format: 'email' } },
      },
    },
  };

  test('reports a missing property at its own path', () => {
    assert.deepEqual(paths(validate(schema, { id: 'a' })), ['/owner required']);
  });

  test('reports nested failures with the full path', () => {
    const r = validate(schema, { id: 'a', owner: { email: 'nope' } });
    assert.deepEqual(paths(r), ['/owner/email format']);
  });

  test('a property set to undefined counts as missing', () => {
    assert.deepEqual(paths(validate(schema, { id: 'a', owner: undefined })), ['/owner required']);
  });

  test('additionalProperties false names each unexpected key', () => {
    const r = validate(schema, { id: 'a', owner: { email: 'a@b.co' }, extra: 1, more: 2 });
    assert.deepEqual(paths(r), ['/extra additionalProperties', '/more additionalProperties']);
  });

  test('additionalProperties as a schema validates the extra values', () => {
    const s = { type: 'object', additionalProperties: { type: 'number' } };
    assert.equal(validate(s, { a: 1, b: 2 }).valid, true);
    assert.deepEqual(paths(validate(s, { a: 1, b: 'x' })), ['/b type']);
  });

  test('collects every error, not just the first', () => {
    const r = validate(schema, { owner: { email: 5 }, x: true });
    assert.deepEqual(paths(r), ['/id required', '/owner/email type', '/x additionalProperties']);
  });

  test('escapes "~" and "/" in keys per RFC 6901', () => {
    const s = { type: 'object', properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } } };
    assert.deepEqual(paths(validate(s, { 'a/b': 1, 'c~d': 2 })), ['/a~1b type', '/c~0d type']);
  });

  test('does not treat inherited keys as present', () => {
    const r = validate({ type: 'object', required: ['toString'] }, {});
    assert.deepEqual(paths(r), ['/toString required']);
  });
});

describe('items', () => {
  test('validates each element with its index in the path', () => {
    const s = { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } };
    const r = validate(s, [{ sku: 'A' }, {}, { sku: 3 }]);
    assert.deepEqual(paths(r), ['/1/sku required', '/2/sku type']);
  });

  test('items: false allows only an empty array', () => {
    assert.equal(validate({ type: 'array', items: false }, []).valid, true);
    assert.deepEqual(paths(validate({ type: 'array', items: false }, [1])), ['/0 false']);
  });
});

describe('enum', () => {
  test('matches by deep equality', () => {
    const s = { enum: ['a', 1, null, { k: [1, 2] }] };
    assert.equal(validate(s, { k: [1, 2] }).valid, true);
    assert.equal(validate(s, null).valid, true);
    assert.equal(validate(s, { k: [2, 1] }).valid, false);
    assert.equal(validate(s, '1').valid, false);
  });

  test('lists the allowed values in the message', () => {
    assert.equal(validate({ enum: ['low', 'high'] }, 'mid').errors[0].message, 'must be one of "low", "high"');
  });
});

describe('strings', () => {
  test('minLength and maxLength count code points, not UTF-16 units', () => {
    const s = { type: 'string', minLength: 2, maxLength: 2 };
    assert.equal(validate(s, '📦📦').valid, true);
    assert.equal(validate(s, '📦').errors[0].keyword, 'minLength');
    assert.equal(validate(s, 'abc').errors[0].keyword, 'maxLength');
  });

  test('pattern is unanchored unless the pattern anchors itself', () => {
    assert.equal(validate({ type: 'string', pattern: 'b' }, 'abc').valid, true);
    assert.equal(validate({ type: 'string', pattern: '^b' }, 'abc').valid, false);
  });

  test('pattern uses Unicode mode', () => {
    assert.equal(validate({ type: 'string', pattern: '^\\p{Lu}' }, 'Été').valid, true);
  });

  test('string keywords are ignored for non-strings when no type is given', () => {
    assert.equal(validate({ minLength: 5, format: 'email' }, 42).valid, true);
  });
});

describe('formats', () => {
  test('date-time accepts RFC 3339 forms', () => {
    for (const v of ['2026-11-24T09:00:00Z', '2026-11-24t09:00:00.123456z', '2026-11-24T09:00:00+05:30', '2024-02-29T00:00:00Z', '2016-12-31T23:59:60Z']) {
      assert.equal(isDateTime(v), true, v);
    }
  });

  test('date-time rejects impossible or partial values', () => {
    for (const v of ['2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '1900-02-29T00:00:00Z', '2026-13-01T00:00:00Z',
      '2026-11-24T24:00:00Z', '2026-11-24T09:60:00Z', '2026-11-24', '2026-11-24T09:00:00', '2026-11-24T09:00Z',
      '2026-11-24T09:00:00+24:00', ' 2026-11-24T09:00:00Z']) {
      assert.equal(isDateTime(v), false, v);
    }
  });

  test('email accepts common addresses and rejects malformed ones', () => {
    for (const v of ['dana@corvane.example', 'd.ana+orders@mail.corvane.example', "o'neil@x.io"]) {
      assert.equal(isEmail(v), true, v);
    }
    for (const v of ['dana', '@corvane.example', 'dana@', 'dana@localhost', 'da..na@x.io', '.dana@x.io',
      'dana@-x.io', 'dana@x..io', 'da na@x.io', `${'a'.repeat(65)}@x.io`]) {
      assert.equal(isEmail(v), false, v);
    }
  });

  test('uri requires an absolute URI', () => {
    for (const v of ['https://help.corvane.example/t/1?x=1#y', 'mailto:dana@corvane.example', 'urn:isbn:0451450523']) {
      assert.equal(isUri(v), true, v);
    }
    for (const v of ['/relative/path', 'help.corvane.example', 'https://exa mple.com', '1http://x.io', '']) {
      assert.equal(isUri(v), false, v);
    }
  });

  test('a format failure is reported with keyword "format"', () => {
    const r = validate({ type: 'string', format: 'uri' }, 'nope');
    assert.deepEqual(r.errors[0], { path: '', keyword: 'format', message: 'must be a valid uri', params: { format: 'uri' } });
  });
});

describe('schema checks', () => {
  test('rejects keywords outside the supported subset', () => {
    assert.throws(() => compile({ type: 'number', minimum: 0 }), (err) => err instanceof SchemaError && /minimum/.test(err.message));
  });

  test('names the location of a bad nested keyword', () => {
    assert.throws(
      () => compile({ properties: { a: { items: { oneOf: [] } } } }),
      (err) => err.path === '/properties/a/items',
    );
  });

  test('rejects unknown formats, types and invalid patterns', () => {
    assert.throws(() => compile({ format: 'ipv4' }), SchemaError);
    assert.throws(() => compile({ type: 'float' }), SchemaError);
    assert.throws(() => compile({ pattern: '(' }), SchemaError);
    assert.throws(() => compile({ minLength: -1 }), SchemaError);
    assert.throws(() => compile({ enum: [] }), SchemaError);
    assert.throws(() => compile({ required: 'id' }), SchemaError);
  });

  test('ignores annotation keywords', () => {
    assert.equal(validate({ title: 'T', description: 'D', $schema: 'x', type: 'string' }, 'a').valid, true);
  });

  test('boolean schemas', () => {
    assert.equal(validate(true, 123).valid, true);
    assert.equal(validate(false, 123).valid, false);
  });

  test('assertValid throws a ValidationError carrying every error', () => {
    const s = { type: 'object', required: ['a', 'b'] };
    assert.throws(() => assertValid(s, {}), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'validation_failed');
      assert.equal(err.errors.length, 2);
      assert.equal(err.message, '/a: is required (and 1 more)');
      return true;
    });
    assert.deepEqual(assertValid(s, { a: 1, b: 2 }), { a: 1, b: 2 });
  });
});
