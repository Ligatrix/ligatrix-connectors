import { CsvParseError, ConnectorError } from '../errors.js';
import { parseCsvRecords } from '../csv.js';
import { applyMapping, defineMapping } from '../mapping.js';
import { normalize } from '../work-item.js';

const readColumn = (row, column) => (Object.hasOwn(row, column) ? row[column] : undefined);

/**
 * Converts CSV text (first record is the header) into WorkItems.
 *
 * Paths in the mapping are column names, matched exactly after trimming the
 * header. One bad row does not stop the import: it is reported in `errors`
 * with the line it starts on, and every other row is still returned.
 *
 * @returns {{ items: object[], errors: { line: number, code: string, message: string, errors?: object[] }[] }}
 */
export function fromCsv(text, mapping, options = {}) {
  const compiled = defineMapping(mapping);
  const records = parseCsvRecords(text, { delimiter: options.delimiter ?? ',' });
  if (records.length === 0) return { items: [], errors: [] };

  const [headerRecord, ...rows] = records;
  const header = headerRecord.fields.map((name) => name.trim());
  const seen = new Set();
  header.forEach((name, i) => {
    if (name === '') throw new CsvParseError(`Header column ${i + 1} is empty`, headerRecord.line, i + 1);
    if (seen.has(name)) throw new CsvParseError(`Duplicate header "${name}"`, headerRecord.line, i + 1);
    seen.add(name);
  });

  const items = [];
  const errors = [];
  for (const { line, fields } of rows) {
    if (fields.length !== header.length) {
      errors.push({
        line,
        code: 'column_count',
        message: `Expected ${header.length} fields, found ${fields.length}`,
      });
      continue;
    }
    const row = Object.fromEntries(header.map((name, i) => [name, fields[i]]));
    try {
      items.push(normalize(applyMapping(compiled, row, readColumn), options));
    } catch (err) {
      if (!(err instanceof ConnectorError)) throw err;
      errors.push({ line, code: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    }
  }
  return { items, errors };
}
