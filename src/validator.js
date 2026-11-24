/**
 * A small validator for a well-defined subset of JSON Schema (draft 2020-12).
 *
 * Supported keywords: type, required, properties, enum, format
 * (date-time, email, uri), minLength, maxLength, pattern, items,
 * additionalProperties. Annotation keywords such as title and description are
 * ignored. Any other keyword is rejected when the schema is compiled, so a
 * schema never appears to enforce a rule that is silently skipped.
 *
 * Error paths are JSON Pointers (RFC 6901): "" is the root, "/labels/2" is the
 * third label, and "~" and "/" inside keys are escaped as "~0" and "~1".
 */

import { SchemaError, ValidationError } from './errors.js';

const SUPPORTED = new Set([
  'type', 'required', 'properties', 'enum', 'format', 'minLength', 'maxLength',
  'pattern', 'items', 'additionalProperties',
]);
const ANNOTATIONS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'examples', 'default',
  'deprecated', 'readOnly', 'writeOnly',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** RFC 3339 date-time, with calendar checks (no 30 February, no hour 24). */
export function isDateTime(value) {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (m[8] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return true;
}

/**
 * A pragmatic address check: a dot-atom local part and a dotted domain of
 * valid labels. Quoted local parts and bare IP domains are not accepted.
 */
export function isEmail(value) {
  if (value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => DOMAIN_LABEL.test(label));
}

/** An absolute URI: a scheme, no whitespace, and parseable by WHATWG URL. */
export function isUri(value) {
  if (!URI_SCHEME.test(value) || /\s/.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const FORMATS = { 'date-time': isDateTime, email: isEmail, uri: isUri };

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite number';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function codePointLength(str) {
  let n = 0;
  for (const _ of str) n += 1;
  return n;
}

/** Turns a schema into a tree of checks, rejecting anything unsupported. */
function compileNode(schema, at) {
  if (schema === true) return { any: true };
  if (schema === false) return { never: true };
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SchemaError(`Schema at "${at}" must be an object or a boolean`, at);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key)) {
      throw new SchemaError(`Unsupported keyword "${key}" at "${at}"`, at);
    }
  }
  const node = {};

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0 || !types.every((t) => TYPES.has(t))) {
      throw new SchemaError(`Invalid "type" at "${at}"`, at);
    }
    node.types = types;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new SchemaError(`"enum" at "${at}" must be a non-empty array`, at);
    }
    node.enum = schema.enum;
  }
  if (schema.format !== undefined) {
    if (!Object.hasOwn(FORMATS, schema.format)) {
      throw new SchemaError(`Unsupported format "${schema.format}" at "${at}"`, at);
    }
    node.format = schema.format;
  }
  for (const key of ['minLength', 'maxLength']) {
    if (schema[key] !== undefined) {
      if (!isNonNegativeInteger(schema[key])) {
        throw new SchemaError(`"${key}" at "${at}" must be a non-negative integer`, at);
      }
      node[key] = schema[key];
    }
  }
  if (schema.pattern !== undefined) {
    try {
      node.pattern = new RegExp(schema.pattern, 'u');
      node.patternSource = schema.pattern;
    } catch (err) {
      throw new SchemaError(`Invalid "pattern" at "${at}": ${err.message}`, at);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === 'string')) {
      throw new SchemaError(`"required" at "${at}" must be an array of strings`, at);
    }
    node.required = schema.required;
  }
  if (schema.properties !== undefined) {
    if (!matchesType(schema.properties, 'object')) {
      throw new SchemaError(`"properties" at "${at}" must be an object`, at);
    }
    node.properties = new Map();
    for (const [key, sub] of Object.entries(schema.properties)) {
      node.properties.set(key, compileNode(sub, `${at}/properties/${escapePointer(key)}`));
    }
  }
  if (schema.additionalProperties !== undefined) {
    node.additionalProperties = compileNode(schema.additionalProperties, `${at}/additionalProperties`);
  }
  if (schema.items !== undefined) {
    node.items = compileNode(schema.items, `${at}/items`);
  }
  return node;
}

function check(node, value, path, errors) {
  if (node.any) return;
  if (node.never) {
    errors.push({ path, keyword: 'false', message: 'is not allowed' });
    return;
  }

  if (node.types && !node.types.some((t) => matchesType(value, t))) {
    errors.push({
      path,
      keyword: 'type',
      message: `must be ${node.types.join(' or ')}, got ${typeOf(value)}`,
      params: { expected: node.types, actual: typeOf(value) },
    });
    return; // the remaining keywords would only repeat the same problem
  }

  if (node.enum && !node.enum.some((allowed) => deepEqual(allowed, value))) {
    errors.push({
      path,
      keyword: 'enum',
      message: `must be one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      params: { allowed: node.enum },
    });
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined || node.maxLength !== undefined) {
      const length = codePointLength(value);
      if (node.minLength !== undefined && length < node.minLength) {
        errors.push({
          path, keyword: 'minLength',
          message: `must be at least ${node.minLength} character${node.minLength === 1 ? '' : 's'} long`,
          params: { limit: node.minLength, actual: length },
        });
      }
      if (node.maxLength !== undefined && length > node.maxLength) {
        errors.push({
          path, keyword: 'maxLength',
          message: `must be at most ${node.maxLength} characters long`,
          params: { limit: node.maxLength, actual: length },
        });
      }
    }
    if (node.pattern && !node.pattern.test(value)) {
      errors.push({
        path, keyword: 'pattern',
        message: `must match pattern ${node.patternSource}`,
        params: { pattern: node.patternSource },
      });
    }
    if (node.format && !FORMATS[node.format](value)) {
      errors.push({
        path, keyword: 'format',
        message: `must be a valid ${node.format}`,
        params: { format: node.format },
      });
    }
  }

  if (matchesType(value, 'object')) {
    if (node.required) {
      for (const key of node.required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          errors.push({
            path: `${path}/${escapePointer(key)}`,
            keyword: 'required',
            message: 'is required',
            params: { property: key },
          });
        }
      }
    }
    for (const key of Object.keys(value)) {
      const child = `${path}/${escapePointer(key)}`;
      if (value[key] === undefined) continue; // treated as absent, as JSON would
      if (node.properties?.has(key)) {
        check(node.properties.get(key), value[key], child, errors);
      } else if (node.additionalProperties) {
        if (node.additionalProperties.never) {
          errors.push({
            path: child, keyword: 'additionalProperties',
            message: 'is not an allowed property',
            params: { property: key },
          });
        } else {
          check(node.additionalProperties, value[key], child, errors);
        }
      }
    }
  }

  if (Array.isArray(value) && node.items) {
    value.forEach((item, i) => check(node.items, item, `${path}/${i}`, errors));
  }
}

/**
 * Compiles a schema once and returns a reusable validation function.
 * Throws SchemaError if the schema uses anything outside the supported subset.
 *
 * @returns {(value: unknown) => { valid: boolean, errors: object[] }}
 */
export function compile(schema) {
  const root = compileNode(schema, '');
  return function validateCompiled(value) {
    const errors = [];
    check(root, value, '', errors);
    return { valid: errors.length === 0, errors };
  };
}

const cache = new WeakMap();

/** Validates `value` against `schema`, compiling and caching the schema on first use. */
export function validate(schema, value) {
  let fn = typeof schema === 'object' && schema !== null ? cache.get(schema) : undefined;
  if (!fn) {
    fn = compile(schema);
    if (typeof schema === 'object' && schema !== null) cache.set(schema, fn);
  }
  return fn(value);
}

/** Like validate, but throws a ValidationError listing every failure. */
export function assertValid(schema, value) {
  const result = validate(schema, value);
  if (!result.valid) throw new ValidationError(result.errors);
  return value;
}
