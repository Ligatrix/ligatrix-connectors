/**
 * Declarative field mappings, shared by the generic webhook adapter and the
 * CSV adapter. A mapping says where each WorkItem field comes from:
 *
 *   {
 *     source: 'forms',
 *     kind: 'request',
 *     fields: {
 *       externalId: 'submission.id',                       // a path
 *       title: { path: ['subject', 'topic'], default: 'Untitled request' },
 *       priority: { path: 'urgency', map: { asap: 'urgent' }, default: 'normal' },
 *       status: { value: 'open' },                         // a constant
 *     },
 *     attributes: { formName: 'form.name' },               // extra facts to keep
 *     currency: 'USD',                                     // for a mapped plain amount
 *   }
 *
 * A field spec is a path string, or an object with `path` (a string or a list
 * tried in order, first non-empty wins), `value` (a constant), `map` (lookup
 * of raw values, case-insensitive) and `default` (used when nothing is found).
 */

import { MappingError } from './errors.js';

export const MAPPABLE_FIELDS = Object.freeze([
  'externalId', 'parentId', 'kind', 'title', 'body', 'status', 'priority', 'requester',
  'assignee', 'labels', 'url', 'amount', 'createdAt', 'updatedAt',
]);
const MAPPABLE = new Set(MAPPABLE_FIELDS);
const SPEC_KEYS = new Set(['path', 'value', 'map', 'default']);

function normalizeSpec(spec, field) {
  if (typeof spec === 'string') return { paths: [spec] };
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new MappingError(`Field "${field}" must be a path string or an object`, field);
  }
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.has(key)) throw new MappingError(`Field "${field}" has unknown option "${key}"`, field);
  }
  const hasPath = spec.path !== undefined;
  const hasValue = Object.hasOwn(spec, 'value');
  if (hasPath && hasValue) throw new MappingError(`Field "${field}" cannot have both "path" and "value"`, field);
  if (!hasPath && !hasValue && !Object.hasOwn(spec, 'default')) {
    throw new MappingError(`Field "${field}" needs "path", "value" or "default"`, field);
  }
  const paths = hasPath ? (Array.isArray(spec.path) ? spec.path : [spec.path]) : [];
  if (paths.some((p) => typeof p !== 'string' || p.trim() === '')) {
    throw new MappingError(`Field "${field}" has an empty or non-string path`, field);
  }
  let map;
  if (spec.map !== undefined) {
    if (spec.map === null || typeof spec.map !== 'object' || Array.isArray(spec.map)) {
      throw new MappingError(`Field "${field}" has a "map" that is not an object`, field);
    }
    map = new Map(Object.entries(spec.map).map(([k, v]) => [k.toLowerCase(), v]));
  }
  return { paths, value: spec.value, hasValue, map, default: spec.default, hasDefault: Object.hasOwn(spec, 'default') };
}

/**
 * Checks a mapping once, up front, so a typo fails at startup rather than on
 * the first delivery. Returns a frozen, ready-to-use mapping.
 */
export function defineMapping(mapping) {
  if (mapping === null || typeof mapping !== 'object') throw new MappingError('Mapping must be an object');
  if (typeof mapping.source !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(mapping.source)) {
    throw new MappingError('Mapping needs a "source": lower case letters, digits, "_" or "-"', 'source');
  }
  if (mapping.fields === null || typeof mapping.fields !== 'object') {
    throw new MappingError('Mapping needs a "fields" object', 'fields');
  }
  const fields = {};
  for (const [field, spec] of Object.entries(mapping.fields)) {
    if (!MAPPABLE.has(field)) {
      throw new MappingError(`"${field}" is not a mappable field; use one of ${MAPPABLE_FIELDS.join(', ')}`, field);
    }
    fields[field] = normalizeSpec(spec, field);
  }
  if (!fields.externalId) throw new MappingError('Mapping must map "externalId"', 'externalId');
  if (!fields.title) throw new MappingError('Mapping must map "title"', 'title');
  const attributes = {};
  for (const [name, spec] of Object.entries(mapping.attributes ?? {})) {
    attributes[name] = normalizeSpec(spec, `attributes.${name}`);
  }
  if (mapping.currency !== undefined && !/^[A-Za-z]{3}$/.test(String(mapping.currency))) {
    throw new MappingError('"currency" must be a three-letter code such as "USD"', 'currency');
  }
  return Object.freeze({
    source: mapping.source,
    kind: mapping.kind,
    currency: mapping.currency,
    fields,
    attributes,
    compiled: true,
  });
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function resolve(spec, record, read) {
  let value;
  if (spec.hasValue) {
    value = spec.value;
  } else {
    for (const path of spec.paths) {
      const found = read(record, path);
      if (!isEmpty(found)) {
        value = found;
        break;
      }
    }
  }
  if (spec.map && !isEmpty(value)) {
    const key = String(value).trim().toLowerCase();
    if (spec.map.has(key)) value = spec.map.get(key);
    else if (spec.hasDefault) value = spec.default;
  }
  if (isEmpty(value) && spec.hasDefault) value = spec.default;
  return value;
}

/** Applies a mapping to one record, producing a partial WorkItem. */
export function applyMapping(mapping, record, read) {
  const compiled = mapping.compiled ? mapping : defineMapping(mapping);
  const partial = { source: compiled.source };
  if (compiled.kind !== undefined) partial.kind = compiled.kind;
  for (const [field, spec] of Object.entries(compiled.fields)) {
    const value = resolve(spec, record, read);
    if (value !== undefined) partial[field] = value;
  }
  if (compiled.currency !== undefined && partial.amount !== undefined
    && (partial.amount === null || typeof partial.amount !== 'object')) {
    partial.amount = { value: partial.amount, currency: compiled.currency };
  }
  const attributes = {};
  for (const [name, spec] of Object.entries(compiled.attributes)) {
    const value = resolve(spec, record, read);
    if (value === undefined) continue;
    attributes[name] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  }
  if (Object.keys(attributes).length) partial.attributes = attributes;
  return partial;
}
