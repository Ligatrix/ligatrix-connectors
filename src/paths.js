/**
 * Dot paths into nested payloads: "ticket.requester.email", "items[0].sku",
 * "items.0.sku" and, for keys containing dots, 'meta["x.y"]'.
 *
 * Only own properties are read, so a path can never reach into
 * Object.prototype (for example "constructor" or "__proto__").
 */

import { MappingError } from './errors.js';

const cache = new Map();

/** Splits a path into segments; numbers are array indices. */
export function parsePath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new MappingError(`Path must be a non-empty string, got ${JSON.stringify(path)}`);
  }
  if (cache.has(path)) return cache.get(path);
  const segments = [];
  let i = 0;
  let expectSegment = true;
  while (i < path.length) {
    const c = path[i];
    if (c === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) throw new MappingError(`Unclosed "[" in path "${path}"`);
      const inner = path.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else if (/^(["']).*\1$/.test(inner) && inner.length >= 2) {
        segments.push(inner.slice(1, -1));
      } else {
        throw new MappingError(`Invalid bracket segment "[${inner}]" in path "${path}"`);
      }
      i = close + 1;
      expectSegment = false;
    } else if (c === '.') {
      if (expectSegment) throw new MappingError(`Empty segment in path "${path}"`);
      i += 1;
      expectSegment = true;
    } else {
      let end = i;
      while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1;
      const name = path.slice(i, end);
      segments.push(/^\d+$/.test(name) ? Number(name) : name);
      i = end;
      expectSegment = false;
    }
  }
  if (expectSegment) throw new MappingError(`Path "${path}" ends with "."`);
  cache.set(path, segments);
  return segments;
}

/** Reads a value at a path; returns undefined when any step is missing. */
export function getPath(object, path) {
  let current = object;
  for (const segment of parsePath(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = typeof segment === 'number' ? segment : Number.NaN;
      if (!Number.isInteger(index) || index >= current.length) return undefined;
      current = current[index];
    } else {
      const key = String(segment);
      if (!Object.hasOwn(current, key)) return undefined;
      current = current[key];
    }
  }
  return current;
}
