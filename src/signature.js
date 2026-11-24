/**
 * Webhook signature verification.
 *
 * Always verify the raw request body exactly as received (a string or a
 * Buffer). Parsing and re-serialising JSON changes whitespace and key order,
 * and the signature will no longer match.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX = /^[0-9a-f]+$/i;

function checkSecret(secret) {
  if (!(typeof secret === 'string' || secret instanceof Uint8Array) || secret.length === 0) {
    throw new TypeError('A non-empty secret (string or Buffer) is required');
  }
}

function checkPayload(payload) {
  if (!(typeof payload === 'string' || payload instanceof Uint8Array)) {
    throw new TypeError('The payload must be the raw body as a string or Buffer');
  }
}

/** HMAC-SHA256 of the payload, as lower-case hex. */
export function signHmac(secret, payload) {
  checkSecret(secret);
  checkPayload(payload);
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Compares two hex digests in constant time. Different lengths or non-hex
 * input return false; the length of a digest is not secret.
 */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) return false;
  if (!HEX.test(a) || !HEX.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Verifies a bare hex HMAC-SHA256 signature. */
export function verifyHmac(secret, payload, signature) {
  return safeEqualHex(signHmac(secret, payload), typeof signature === 'string' ? signature.trim() : '');
}

/** Builds the X-Hub-Signature-256 header value GitHub sends: "sha256=<hex>". */
export function signGitHub(secret, payload) {
  return `sha256=${signHmac(secret, payload)}`;
}

/** Verifies GitHub's X-Hub-Signature-256 header against the raw body. */
export function verifyGitHubSignature(secret, payload, header) {
  if (typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  return safeEqualHex(signHmac(secret, payload), m[1].toLowerCase());
}

/**
 * Signs a payload with the timestamped scheme: the signed text is
 * "<t>.<payload>" and the header is "t=<unix seconds>,v1=<hex>".
 */
export function signTimestamped(secret, payload, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new TypeError('timestamp must be whole Unix seconds');
  const body = typeof payload === 'string' ? payload : Buffer.from(payload);
  checkPayload(body);
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]);
  return `t=${timestamp},v1=${signHmac(secret, signed)}`;
}

/**
 * Parses "t=…,v1=…[,v1=…]". Several v1 values are allowed so a sender can
 * sign with an old and a new secret while rotating. Unknown keys are ignored.
 * Returns null when the header is malformed.
 */
export function parseTimestampedHeader(header) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  let timestamp;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verifies a timestamped signature header.
 *
 * Checks, in order: the header parses; the timestamp is within
 * `toleranceSeconds` of now (either direction); one v1 signature matches;
 * and, when a `replayStore` is given, this exact signature has not been
 * accepted before. The replay record is written only after the signature
 * matches, so forged requests cannot fill the store.
 *
 * @returns {Promise<{ valid: true, timestamp: number } | { valid: false, reason: 'malformed'|'outside_tolerance'|'mismatch'|'replayed' }>}
 */
export async function verifyTimestamped(secret, payload, header, options = {}) {
  const { toleranceSeconds = 300, now = Date.now, replayStore } = options;
  checkSecret(secret);
  checkPayload(payload);
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new TypeError('toleranceSeconds must be a non-negative number');
  }
  const parsed = parseTimestampedHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed' };

  const nowSeconds = Math.floor(Number(now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'outside_tolerance' };
  }

  const expected = signTimestamped(secret, payload, { timestamp: parsed.timestamp }).split('v1=')[1];
  let matched = false;
  for (const candidate of parsed.signatures) {
    // check every candidate so the time taken does not reveal which matched
    if (safeEqualHex(expected, candidate)) matched = true;
  }
  if (!matched) return { valid: false, reason: 'mismatch' };

  if (replayStore) {
    const ttlMs = (toleranceSeconds * 2 + 1) * 1000;
    const fresh = await replayStore.setIfAbsent(`replay:${parsed.timestamp}:${expected}`, true, ttlMs);
    if (!fresh) return { valid: false, reason: 'replayed' };
  }
  return { valid: true, timestamp: parsed.timestamp };
}
