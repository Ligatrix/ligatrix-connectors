import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  signHmac, verifyHmac, safeEqualHex, signGitHub, verifyGitHubSignature, signTimestamped,
  parseTimestampedHeader, verifyTimestamped, MemoryTtlStore,
} from '../src/index.js';

const secret = 'whsec_demo_only';
const body = '{"id":"sub_00981","total":12}';

describe('HMAC-SHA256', () => {
  test('matches a known vector (RFC 4231 test case 2)', () => {
    assert.equal(
      signHmac('Jefe', 'what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  test('verifies strings and Buffers alike', () => {
    const sig = signHmac(secret, body);
    assert.equal(verifyHmac(secret, body, sig), true);
    assert.equal(verifyHmac(Buffer.from(secret), Buffer.from(body), sig.toUpperCase()), true);
  });

  test('any change to body, secret or signature fails', () => {
    const sig = signHmac(secret, body);
    assert.equal(verifyHmac(secret, `${body} `, sig), false);
    assert.equal(verifyHmac('other', body, sig), false);
    assert.equal(verifyHmac(secret, body, sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')), false);
    assert.equal(verifyHmac(secret, body, sig.slice(0, 32)), false);
    assert.equal(verifyHmac(secret, body, undefined), false);
  });

  test('safeEqualHex refuses non-hex and odd lengths without throwing', () => {
    assert.equal(safeEqualHex('zz', 'zz'), false);
    assert.equal(safeEqualHex('abc', 'abc'), false);
    assert.equal(safeEqualHex('', ''), false);
    assert.equal(safeEqualHex('ab', 'AB'), true);
  });

  test('an empty secret or a parsed object as payload is a programming error', () => {
    assert.throws(() => signHmac('', body), TypeError);
    assert.throws(() => signHmac(secret, { id: 1 }), TypeError);
  });
});

describe('GitHub X-Hub-Signature-256', () => {
  test('accepts the header GitHub sends', () => {
    const header = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    assert.equal(signGitHub(secret, body), header);
    assert.equal(verifyGitHubSignature(secret, body, header), true);
  });

  test('rejects the wrong prefix, a sha1 header, a missing header or a re-serialised body', () => {
    const hex = signHmac(secret, body);
    assert.equal(verifyGitHubSignature(secret, body, `sha1=${hex}`), false);
    assert.equal(verifyGitHubSignature(secret, body, hex), false);
    assert.equal(verifyGitHubSignature(secret, body, undefined), false);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    assert.equal(verifyGitHubSignature(secret, reserialised, `sha256=${hex}`), false);
  });
});

describe('timestamped t=…,v1=… scheme', () => {
  const t = 1795424400; // 2026-11-23T09:00:00Z
  const at = (seconds) => () => seconds * 1000;

  test('round-trips and reports the timestamp', async () => {
    const header = signTimestamped(secret, body, { timestamp: t });
    assert.match(header, /^t=1795424400,v1=[0-9a-f]{64}$/);
    assert.deepEqual(await verifyTimestamped(secret, body, header, { now: at(t + 10) }), { valid: true, timestamp: t });
  });

  test('the signed text is "<t>.<body>"', () => {
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    assert.equal(signTimestamped(secret, body, { timestamp: t }), `t=${t},v1=${expected}`);
  });

  test('rejects timestamps outside the tolerance, in either direction', async () => {
    const header = signTimestamped(secret, body, { timestamp: t });
    assert.equal((await verifyTimestamped(secret, body, header, { now: at(t + 300) })).valid, true);
    assert.deepEqual(await verifyTimestamped(secret, body, header, { now: at(t + 301) }), { valid: false, reason: 'outside_tolerance' });
    assert.deepEqual(await verifyTimestamped(secret, body, header, { now: at(t - 301) }), { valid: false, reason: 'outside_tolerance' });
    assert.equal((await verifyTimestamped(secret, body, header, { now: at(t + 900), toleranceSeconds: 900 })).valid, true);
  });

  test('a changed timestamp invalidates the signature', async () => {
    const header = signTimestamped(secret, body, { timestamp: t }).replace(`t=${t}`, `t=${t + 1}`);
    assert.deepEqual(await verifyTimestamped(secret, body, header, { now: at(t) }), { valid: false, reason: 'mismatch' });
  });

  test('accepts any one of several v1 signatures (secret rotation)', async () => {
    const oldSig = signTimestamped('old-secret', body, { timestamp: t }).split('v1=')[1];
    const newSig = signTimestamped(secret, body, { timestamp: t }).split('v1=')[1];
    const header = `t=${t}, v1=${oldSig}, v1=${newSig}, v0=ignored`;
    assert.equal((await verifyTimestamped(secret, body, header, { now: at(t) })).valid, true);
    assert.equal((await verifyTimestamped('old-secret', body, header, { now: at(t) })).valid, true);
    assert.equal((await verifyTimestamped('third', body, header, { now: at(t) })).reason, 'mismatch');
  });

  test('malformed headers', async () => {
    const sig = 'a'.repeat(64);
    for (const header of [undefined, '', `v1=${sig}`, `t=${t}`, `t=abc,v1=${sig}`, `t=${t},v1=xyz`,
      `t=${t},t=${t},v1=${sig}`, `t=${t};v1=${sig}`, `t=-5,v1=${sig}`]) {
      assert.equal(parseTimestampedHeader(header), null, String(header));
      assert.deepEqual(await verifyTimestamped(secret, body, header, { now: at(t) }), { valid: false, reason: 'malformed' });
    }
  });

  test('a replay store rejects the second delivery of the same signature', async () => {
    let clock = t * 1000;
    const replayStore = new MemoryTtlStore({ now: () => clock });
    const header = signTimestamped(secret, body, { timestamp: t });
    const opts = { now: () => clock, replayStore };
    assert.equal((await verifyTimestamped(secret, body, header, opts)).valid, true);
    assert.deepEqual(await verifyTimestamped(secret, body, header, opts), { valid: false, reason: 'replayed' });
    clock += 60_000;
    assert.equal((await verifyTimestamped(secret, body, header, opts)).reason, 'replayed', 'still remembered within tolerance');
    const fresh = signTimestamped(secret, body, { timestamp: t + 60 });
    assert.equal((await verifyTimestamped(secret, body, fresh, opts)).valid, true, 'a new signature of the same body is fine');
  });

  test('forged requests are not recorded in the replay store', async () => {
    const replayStore = new MemoryTtlStore({ now: at(t) });
    const forged = `t=${t},v1=${'0'.repeat(64)}`;
    await verifyTimestamped(secret, body, forged, { now: at(t), replayStore });
    assert.equal(replayStore.size, 0);
  });

  test('works with an asynchronous store', async () => {
    const seen = new Set();
    const asyncStore = {
      async setIfAbsent(key) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    };
    const header = signTimestamped(secret, body, { timestamp: t });
    assert.equal((await verifyTimestamped(secret, body, header, { now: at(t), replayStore: asyncStore })).valid, true);
    assert.equal((await verifyTimestamped(secret, body, header, { now: at(t), replayStore: asyncStore })).reason, 'replayed');
  });

  test('invalid options are programming errors', async () => {
    await assert.rejects(verifyTimestamped(secret, body, 't=1,v1=x', { toleranceSeconds: -1 }), TypeError);
    assert.throws(() => signTimestamped(secret, body, { timestamp: 1.5 }), TypeError);
  });
});
