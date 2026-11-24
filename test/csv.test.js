import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRecords, CsvParseError } from '../src/index.js';

describe('parseCsv', () => {
  test('plain fields and both line endings', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  test('a lone CR also ends a record', () => {
    assert.deepEqual(parseCsv('a,b\r1,2\r'), [['a', 'b'], ['1', '2']]);
  });

  test('quoted fields keep delimiters, escaped quotes and line breaks', () => {
    const text = 'id,note\n1,"Dock 3, not the ""front"" office"\n2,"line one\r\nline two"\n';
    assert.deepEqual(parseCsv(text), [
      ['id', 'note'],
      ['1', 'Dock 3, not the "front" office'],
      ['2', 'line one\r\nline two'],
    ]);
  });

  test('empty fields, including trailing and quoted empties', () => {
    assert.deepEqual(parseCsv('a,,c,\n"",x,"",'), [['a', '', 'c', ''], ['', 'x', '', '']]);
  });

  test('a final line break does not add a record; blank lines are skipped', () => {
    assert.deepEqual(parseCsv('a\n\n1\n\n'), [['a'], ['1']]);
  });

  test('a quoted empty field on its own line is a record, not a blank line', () => {
    assert.deepEqual(parseCsv('a\n""\n'), [['a'], ['']]);
  });

  test('drops a byte order mark', () => {
    assert.deepEqual(parseCsv('﻿id\n1'), [['id'], ['1']]);
  });

  test('keeps spaces around unquoted fields as data', () => {
    assert.deepEqual(parseCsv(' a , b '), [[' a ', ' b ']]);
  });

  test('custom delimiter', () => {
    assert.deepEqual(parseCsv('a;b\n"1;2";3', { delimiter: ';' }), [['a', 'b'], ['1;2', '3']]);
    assert.deepEqual(parseCsv('a\tb', { delimiter: '\t' }), [['a', 'b']]);
    assert.throws(() => parseCsv('a', { delimiter: '"' }), TypeError);
    assert.throws(() => parseCsv('a', { delimiter: ';;' }), TypeError);
  });

  test('empty input gives no records', () => {
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('\n\n'), []);
  });

  test('records know the line they start on, across multi-line fields', () => {
    const records = parseCsvRecords('h\n"a\nb\nc"\nnext\r\n"x\r\ny"\nlast');
    assert.deepEqual(records.map((r) => r.line), [1, 2, 5, 6, 8]);
  });

  test('an unclosed quote is an error at the opening quote', () => {
    assert.throws(() => parseCsv('a,b\n1,"never\nclosed'), (err) => {
      assert.ok(err instanceof CsvParseError);
      assert.equal(err.line, 2);
      assert.equal(err.column, 3);
      return true;
    });
  });

  test('a quote inside an unquoted field is an error', () => {
    assert.throws(() => parseCsv('a,b"c'), (err) => err.line === 1 && err.column === 4);
  });

  test('text after a closing quote is an error', () => {
    assert.throws(() => parseCsv('id\n"ab"c'), (err) => err.line === 2 && err.column === 5 && /after closing quote/.test(err.message));
  });

  test('refuses non-string input', () => {
    assert.throws(() => parseCsv(Buffer.from('a')), TypeError);
  });
});
