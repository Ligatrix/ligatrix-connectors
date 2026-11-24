/**
 * An RFC 4180 CSV reader.
 *
 * - Fields may be quoted; inside quotes, "" is a literal quote and delimiters
 *   and line breaks are part of the field.
 * - Records end at CRLF, LF or a lone CR.
 * - A leading byte order mark is dropped; a final line break does not add an
 *   empty record; blank lines are skipped.
 * - Malformed input (an unclosed quote, a quote inside an unquoted field,
 *   text after a closing quote) throws CsvParseError with the line and column.
 */

import { CsvParseError } from './errors.js';

function checkDelimiter(delimiter) {
  if (typeof delimiter !== 'string' || [...delimiter].length !== 1 || /["\r\n]/.test(delimiter)) {
    throw new TypeError('delimiter must be a single character other than a quote or a line break');
  }
}

/**
 * Parses CSV text into records, each with the line it starts on.
 * @returns {{ line: number, fields: string[] }[]}
 */
export function parseCsvRecords(text, { delimiter = ',' } = {}) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be a string');
  checkDelimiter(delimiter);
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false;     // the current field started with a quote
  let inQuotes = false;   // we are between its opening and closing quote
  let afterQuote = false; // the closing quote has been read
  let line = 1;
  let lineStart = 0;
  let recordLine = 1;
  let quoteLine = 1;
  let quoteColumn = 1;
  let quotedRecordField = false; // any field of the current record was quoted

  const endField = () => {
    fields.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    const blank = fields.length === 1 && fields[0] === '' && !quotedRecordField;
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (c === '\n' || (c === '\r' && input[i + 1] !== '\n')) {
          line += 1;
          lineStart = i + 1;
        }
        field += c;
      }
      continue;
    }
    if (c === delimiter) {
      endField();
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      endField();
      endRecord();
      quotedRecordField = false;
      line += 1;
      lineStart = i + 1;
      recordLine = line;
      continue;
    }
    if (afterQuote) {
      throw new CsvParseError('Unexpected character after closing quote', line, i - lineStart + 1);
    }
    if (c === '"') {
      if (field !== '' || quoted) {
        throw new CsvParseError('Quote inside an unquoted field', line, i - lineStart + 1);
      }
      quoted = true;
      quotedRecordField = true;
      inQuotes = true;
      quoteLine = line;
      quoteColumn = i - lineStart + 1;
      continue;
    }
    field += c;
  }

  if (inQuotes) throw new CsvParseError('Unclosed quoted field', quoteLine, quoteColumn);
  if (field !== '' || fields.length > 0 || quoted) {
    endField();
    endRecord();
  }
  return records;
}

/** Parses CSV text into an array of rows, each an array of strings. */
export function parseCsv(text, options) {
  return parseCsvRecords(text, options).map((record) => record.fields);
}
