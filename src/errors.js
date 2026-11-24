/**
 * Error types raised by the library. Every error carries a stable `code`
 * so callers can branch on it without parsing messages.
 */

export class ConnectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.assign(this, details);
  }
}

/** A value did not match a schema. `errors` lists every failure with its path. */
export class ValidationError extends ConnectorError {
  constructor(errors, message) {
    const first = errors[0];
    const summary = message
      ?? (first ? `${first.path || '(root)'}: ${first.message}` : 'Validation failed');
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
    super('validation_failed', summary + more, { errors });
  }
}

/** A schema uses a keyword or value this validator does not support. */
export class SchemaError extends ConnectorError {
  constructor(message, path = '') {
    super('invalid_schema', message, { path });
  }
}

/** An inbound payload could not be mapped by an adapter. */
export class AdapterError extends ConnectorError {
  constructor(code, message, path = '') {
    super(code, message, { path });
  }
}

/** A field mapping definition is invalid. */
export class MappingError extends ConnectorError {
  constructor(message, field = '') {
    super('invalid_mapping', message, { field });
  }
}

/** CSV text is malformed. `line` and `column` are 1-based. */
export class CsvParseError extends ConnectorError {
  constructor(message, line, column) {
    super('csv_parse_error', `${message} (line ${line}, column ${column})`, { line, column });
  }
}
