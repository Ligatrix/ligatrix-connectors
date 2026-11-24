/**
 * The one normaliser. Every adapter builds a partial WorkItem from its own
 * payload and hands it here; this module fills defaults, cleans values and
 * validates the result against schemas/work-item.schema.json. Adapters never
 * build final WorkItems themselves, so the rules below hold for every source.
 */

import { readFileSync } from 'node:fs';
import { ValidationError } from './errors.js';
import { compile, isDateTime } from './validator.js';

export const workItemSchema = JSON.parse(
  readFileSync(new URL('../schemas/work-item.schema.json', import.meta.url), 'utf8'),
);

const validateWorkItemSchema = compile(workItemSchema);

export const KINDS = Object.freeze([...workItemSchema.properties.kind.enum]);
export const STATUSES = Object.freeze([...workItemSchema.properties.status.enum]);
export const PRIORITIES = Object.freeze([...workItemSchema.properties.priority.enum]);

const TITLE_MAX = workItemSchema.properties.title.maxLength;
const FIELDS = [
  'id', 'source', 'externalId', 'parentId', 'kind', 'title', 'body', 'status', 'priority',
  'requester', 'assignee', 'labels', 'url', 'amount', 'createdAt', 'updatedAt', 'receivedAt',
  'attributes',
];
const KNOWN = new Set(FIELDS);

const LOOSE_DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?)?\s*([Zz]|[+-]\d{2}:?\d{2})?$/;

/**
 * Converts a timestamp to an RFC 3339 UTC string with milliseconds.
 *
 * Accepts Date objects, epoch numbers (seconds below 1e11, otherwise
 * milliseconds) and ISO-like strings. A date or time with no offset is read as
 * UTC, never as the server's local time. A value that cannot be read is
 * returned unchanged so validation reports it against its own field.
 */
export function toTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  if (typeof value === 'string') {
    const m = LOOSE_DATE_TIME.exec(value.trim());
    if (!m) return value;
    const [, date, hm = '00:00', secs = ':00', zone = 'Z'] = m;
    const offset = /^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
    const candidate = `${date}T${hm}${secs}${offset}`;
    if (!isDateTime(candidate)) return value;
    const parsed = new Date(candidate);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return value;
}

function cleanText(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function cleanTitle(value) {
  const text = cleanText(value);
  if (text === undefined) return undefined;
  const single = text.replace(/\s+/g, ' ');
  const chars = [...single];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…` : single;
}

function cleanBody(value) {
  const text = cleanText(value);
  return text === undefined ? undefined : text.replace(/\r\n?/g, '\n');
}

/** "Dana <dana@corvane.example>", "dana@corvane.example", "Dana" or { name, email }. */
export function toPerson(value) {
  if (value === undefined || value === null) return undefined;
  let name;
  let email;
  if (typeof value === 'object' && !Array.isArray(value)) {
    name = cleanText(value.name);
    email = cleanText(value.email);
  } else {
    const text = cleanText(value);
    if (text === undefined) return undefined;
    const angled = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(text);
    if (angled) {
      name = cleanText(angled[1].replace(/^"|"$/g, ''));
      email = angled[2];
    } else if (/^[^\s@]+@[^\s@]+$/.test(text)) {
      email = text;
    } else {
      name = text;
    }
  }
  const person = {};
  if (name !== undefined) person.name = name;
  if (email !== undefined) person.email = email.toLowerCase();
  return Object.keys(person).length ? person : undefined;
}

function cleanLabels(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[,;]/) : [value];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const label = cleanText(typeof raw === 'object' && raw !== null ? raw.name : raw);
    if (label === undefined) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function cleanAmount(value, currency) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return cleanAmount(value.value, value.currency ?? currency);
  }
  let number = value;
  if (typeof value === 'string') {
    const stripped = value.replace(/[\s,]/g, '').replace(/^[$€£]/, '');
    number = stripped === '' ? Number.NaN : Number(stripped);
    if (Number.isNaN(number)) number = value; // left for validation to report
  }
  const code = cleanText(currency);
  return { value: number, currency: code === undefined ? code : code.toUpperCase() };
}

function cleanEnum(value, fallback) {
  const text = cleanText(value);
  return text === undefined ? fallback : text.toLowerCase().replace(/[\s-]+/g, '_');
}

function cleanAttributes(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = v instanceof Date ? toTimestamp(v) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Builds a validated WorkItem from a partial one.
 *
 * Defaults: kind "task", status "open", priority "normal", labels [],
 * receivedAt now, createdAt receivedAt, updatedAt createdAt. The id is always
 * "<source>:<externalId>" and cannot be overridden.
 *
 * @param {object} partial
 * @param {{ now?: () => Date | number | string }} [options]
 * @throws {ValidationError} listing every invalid or missing field
 */
export function normalize(partial, options = {}) {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new ValidationError([{ path: '', keyword: 'type', message: 'must be object' }]);
  }
  const unknown = Object.keys(partial).filter((k) => !KNOWN.has(k) && partial[k] !== undefined);
  if (unknown.length) {
    throw new ValidationError(unknown.map((k) => ({
      path: `/${k}`, keyword: 'additionalProperties', message: 'is not a WorkItem field',
      params: { property: k },
    })));
  }

  const now = options.now ? options.now() : new Date();
  const source = cleanText(partial.source)?.toLowerCase();
  const externalId = cleanText(partial.externalId);
  const receivedAt = toTimestamp(partial.receivedAt ?? now);
  const createdAt = toTimestamp(partial.createdAt ?? receivedAt);
  // an unreadable createdAt is reported once, not again through its default
  const updatedAt = toTimestamp(partial.updatedAt ?? (isDateTime(String(createdAt)) ? createdAt : receivedAt));

  const item = {
    id: source !== undefined && externalId !== undefined ? `${source}:${externalId}` : undefined,
    source,
    externalId,
    parentId: cleanText(partial.parentId),
    kind: cleanEnum(partial.kind, 'task'),
    title: cleanTitle(partial.title),
    body: cleanBody(partial.body),
    status: cleanEnum(partial.status, 'open'),
    priority: cleanEnum(partial.priority, 'normal'),
    requester: toPerson(partial.requester),
    assignee: toPerson(partial.assignee),
    labels: cleanLabels(partial.labels),
    url: cleanText(partial.url),
    amount: cleanAmount(partial.amount),
    createdAt,
    updatedAt,
    receivedAt,
    attributes: cleanAttributes(partial.attributes),
  };
  for (const key of FIELDS) if (item[key] === undefined) delete item[key];

  const { valid, errors } = validateWorkItemSchema(item);
  if (!valid) throw new ValidationError(errors);
  return item;
}

/** Validates an existing WorkItem without changing it. */
export function validateWorkItem(item) {
  return validateWorkItemSchema(item);
}
