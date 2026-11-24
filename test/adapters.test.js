import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fromGitHub, fromCrmEvent, fromHelpdeskEvent, fromWebhook, fromCsv, defineMapping, priorityFromLabels,
  getPath, parsePath, validateWorkItem, AdapterError, MappingError, ValidationError, CsvParseError,
} from '../src/index.js';

const now = () => new Date('2026-11-24T09:00:00Z');
const fixture = (name) => JSON.parse(readFileSync(new URL(`../examples/payloads/${name}`, import.meta.url), 'utf8'));
const clone = (v) => structuredClone(v);

describe('paths', () => {
  test('dot, index and quoted-key segments', () => {
    const data = { a: { b: [{ c: 1 }, { c: 2 }] }, 'x.y': { z: 3 }, list: ['p', 'q'] };
    assert.equal(getPath(data, 'a.b[1].c'), 2);
    assert.equal(getPath(data, 'a.b.0.c'), 1);
    assert.equal(getPath(data, '["x.y"].z'), 3);
    assert.equal(getPath(data, 'list[1]'), 'q');
    assert.equal(getPath(data, 'list[5]'), undefined);
    assert.equal(getPath(data, 'a.missing.deeper'), undefined);
    assert.equal(getPath(data, 'list.first'), undefined);
  });

  test('never reads inherited properties', () => {
    assert.equal(getPath({}, 'constructor'), undefined);
    assert.equal(getPath({ a: {} }, 'a.__proto__'), undefined);
    assert.equal(getPath({ s: 'text' }, 's.length'), undefined);
  });

  test('rejects malformed paths', () => {
    for (const p of ['', 'a..b', '.a', 'a.', 'a[', 'a[x]', 'a[-1]']) {
      assert.throws(() => parsePath(p), MappingError, p);
    }
  });
});

describe('GitHub', () => {
  test('maps an issue event', () => {
    const item = fromGitHub(fixture('github-issue.json'), { event: 'issues', deliveryId: 'd-1', now });
    assert.equal(item.id, 'github:corvane-supply/ops-portal#214');
    assert.equal(item.kind, 'issue');
    assert.equal(item.status, 'open');
    assert.equal(item.priority, 'high');
    assert.deepEqual(item.requester, { name: 'dana-corvane' });
    assert.deepEqual(item.assignee, { name: 'omar-corvane' });
    assert.deepEqual(item.labels, ['bug', 'warehouse', 'priority: high']);
    assert.equal(item.attributes.deliveryId, 'd-1');
    assert.equal(item.body.includes('\r'), false);
    assert.equal(validateWorkItem(item).valid, true);
  });

  test('closed issues become done, or cancelled when closed as not planned', () => {
    const payload = fixture('github-issue.json');
    payload.issue.state = 'closed';
    payload.issue.state_reason = 'completed';
    assert.equal(fromGitHub(payload, { event: 'issues', now }).status, 'done');
    payload.issue.state_reason = 'not_planned';
    assert.equal(fromGitHub(payload, { event: 'issues', now }).status, 'cancelled');
  });

  test('every event about one issue keeps the same id', () => {
    const a = fixture('github-issue.json');
    const b = clone(a);
    b.action = 'edited';
    b.issue.title = 'Renamed';
    assert.equal(fromGitHub(a, { event: 'issues', now }).id, fromGitHub(b, { event: 'issues', now }).id);
  });

  test('maps a comment with a parentId pointing at the issue', () => {
    const item = fromGitHub(fixture('github-issue-comment.json'), { event: 'issue_comment', now });
    assert.equal(item.id, 'github:corvane-supply/ops-portal#214/comments/90817');
    assert.equal(item.parentId, 'github:corvane-supply/ops-portal#214');
    assert.equal(item.kind, 'comment');
    assert.equal(item.title, 'Comment on #214: Pick list prints twice for split orders');
    assert.equal(item.attributes.onPullRequest, false);
  });

  test('a deleted comment is cancelled; a comment on a pull request is flagged', () => {
    const payload = fixture('github-issue-comment.json');
    payload.action = 'deleted';
    payload.issue.pull_request = { url: 'https://api.github.com/repos/corvane-supply/ops-portal/pulls/214' };
    const item = fromGitHub(payload, { event: 'issue_comment', now });
    assert.equal(item.status, 'cancelled');
    assert.equal(item.attributes.onPullRequest, true);
  });

  test('a null body or assignee is simply left out', () => {
    const payload = fixture('github-issue.json');
    payload.issue.body = null;
    payload.issue.assignee = null;
    payload.issue.assignees = [];
    const item = fromGitHub(payload, { event: 'issues', now });
    assert.equal('body' in item, false);
    assert.equal('assignee' in item, false);
  });

  test('priority labels: the most urgent wins, unrelated labels are ignored', () => {
    assert.equal(priorityFromLabels([{ name: 'P2' }, { name: 'priority/urgent' }]), 'urgent');
    assert.equal(priorityFromLabels(['Priority: Low']), 'low');
    assert.equal(priorityFromLabels(['high', 'bug', 'p7']), undefined);
  });

  test('unsupported events and broken payloads are refused with a code', () => {
    assert.throws(() => fromGitHub({}, { event: 'push' }), (err) => err instanceof AdapterError && err.code === 'unsupported_event');
    const payload = fixture('github-issue.json');
    delete payload.repository;
    assert.throws(() => fromGitHub(payload, { event: 'issues' }), (err) => err.code === 'invalid_payload' && err.path === 'repository.full_name');
    assert.throws(() => fromGitHub({ repository: { full_name: 'a/b' }, issue: { number: '7' } }, { event: 'issues' }),
      (err) => err.path === 'issue.number');
    const comment = fixture('github-issue-comment.json');
    delete comment.comment;
    assert.throws(() => fromGitHub(comment, { event: 'issue_comment' }), (err) => err.path === 'comment');
  });
});

describe('CRM', () => {
  test('maps a deal, its stage, amount and people', () => {
    const item = fromCrmEvent(fixture('crm-deal.json'), { now });
    assert.equal(item.id, 'crm:deal/D-1042');
    assert.equal(item.status, 'in_progress');
    assert.deepEqual(item.amount, { value: 48500, currency: 'USD' });
    assert.deepEqual(item.assignee, { name: 'Dana', email: 'dana@corvane.example' });
    assert.equal(item.attributes.stage, 'Proposal');
  });

  test('won and lost deals close, deleted deals are cancelled', () => {
    const payload = fixture('crm-deal.json');
    payload.data.stage = 'Closed Won';
    assert.equal(fromCrmEvent(payload, { now }).status, 'done');
    payload.data.stage = 'closed-lost';
    assert.equal(fromCrmEvent(payload, { now }).status, 'cancelled');
    payload.type = 'deal.deleted';
    payload.data.stage = 'something new';
    assert.equal(fromCrmEvent(payload, { now }).status, 'cancelled');
  });

  test('an unknown stage is an error unless the stage map covers it', () => {
    const payload = fixture('crm-deal.json');
    payload.data.stage = 'Legal review';
    assert.throws(() => fromCrmEvent(payload, { now }), (err) => err.code === 'unknown_stage' && err.path === 'data.stage');
    assert.equal(fromCrmEvent(payload, { now, stageMap: { legal_review: 'waiting' } }).status, 'waiting');
  });

  test('a deal without an amount has no amount field; a custom source is used in the id', () => {
    const payload = fixture('crm-deal.json');
    delete payload.data.amount;
    const item = fromCrmEvent(payload, { now, source: 'pipeline' });
    assert.equal('amount' in item, false);
    assert.equal(item.id, 'pipeline:deal/D-1042');
  });

  test('maps a contact, reading an offset timestamp as UTC', () => {
    const item = fromCrmEvent(fixture('crm-contact.json'), { now });
    assert.equal(item.id, 'crm:contact/C-3307');
    assert.equal(item.title, 'Leo Marsh');
    assert.deepEqual(item.requester, { name: 'Leo Marsh', email: 'leo.marsh@buyer.example' });
    assert.deepEqual(item.assignee, { name: 'Dana', email: 'dana@corvane.example' });
    assert.equal(item.createdAt, '2026-11-22T08:41:00.000Z');
  });

  test('deal and contact ids never collide', () => {
    const deal = fixture('crm-deal.json');
    const contact = fixture('crm-contact.json');
    deal.data.id = 'X1';
    contact.data.id = 'X1';
    assert.notEqual(fromCrmEvent(deal, { now }).id, fromCrmEvent(contact, { now }).id);
  });

  test('refuses unsupported types and missing ids', () => {
    assert.throws(() => fromCrmEvent({ type: 'invoice.paid', data: { id: 1 } }), (err) => err.code === 'unsupported_event');
    assert.throws(() => fromCrmEvent({ type: 'deal.created', data: {} }), (err) => err.path === 'data.id');
    assert.throws(() => fromCrmEvent(null), AdapterError);
  });
});

describe('helpdesk', () => {
  test('maps a ticket, its status, priority and tags', () => {
    const item = fromHelpdeskEvent(fixture('helpdesk-ticket.json'), { now });
    assert.equal(item.id, 'helpdesk:4821');
    assert.equal(item.title, 'Invoice shows the wrong shipping address');
    assert.equal(item.status, 'waiting');
    assert.equal(item.priority, 'urgent');
    assert.deepEqual(item.labels, ['billing', 'address']);
    assert.equal(item.createdAt, '2026-11-23T16:02:10.000Z');
    assert.equal(item.updatedAt, '2026-11-23T16:45:00.000Z');
    assert.equal(item.attributes.sourceStatus, 'pending');
  });

  test('status table covers the usual helpdesk states', () => {
    const payload = fixture('helpdesk-ticket.json');
    for (const [raw, expected] of [['new', 'open'], ['On Hold', 'waiting'], ['solved', 'done'], ['closed', 'done']]) {
      payload.ticket.status = raw;
      assert.equal(fromHelpdeskEvent(payload, { now }).status, expected, raw);
    }
  });

  test('solved and deleted events override the ticket status', () => {
    const payload = fixture('helpdesk-ticket.json');
    payload.event = 'ticket.solved';
    assert.equal(fromHelpdeskEvent(payload, { now }).status, 'done');
    payload.event = 'ticket.deleted';
    assert.equal(fromHelpdeskEvent(payload, { now }).status, 'cancelled');
  });

  test('unknown status or priority values are errors, not guesses', () => {
    const payload = fixture('helpdesk-ticket.json');
    payload.ticket.status = 'escalated';
    assert.throws(() => fromHelpdeskEvent(payload, { now }), (err) => err.code === 'unknown_status');
    payload.ticket.status = 'open';
    payload.ticket.priority = 'p9';
    assert.throws(() => fromHelpdeskEvent(payload, { now }), (err) => err.code === 'unknown_priority' && err.path === 'ticket.priority');
  });

  test('a ticket without a subject fails validation at /title', () => {
    const payload = fixture('helpdesk-ticket.json');
    payload.ticket.subject = '   ';
    assert.throws(() => fromHelpdeskEvent(payload, { now }), (err) => err instanceof ValidationError && err.errors[0].path === '/title');
  });

  test('refuses other events', () => {
    assert.throws(() => fromHelpdeskEvent({ event: 'user.login', ticket: { id: 1 } }), (err) => err.code === 'unsupported_event');
    assert.throws(() => fromHelpdeskEvent({ event: 'ticket.created' }), (err) => err.path === 'ticket.id');
  });
});

describe('generic webhook', () => {
  const mapping = defineMapping({
    source: 'forms',
    kind: 'request',
    fields: {
      externalId: 'submission.id',
      title: { path: ['submission.fields.subject', 'submission.fields.topic'], default: 'Untitled request' },
      body: 'submission.fields.message',
      requester: 'submission.fields.email',
      priority: { path: 'submission.fields.urgency', map: { asap: 'urgent', soon: 'high' }, default: 'normal' },
      labels: 'submission.tags',
      createdAt: 'submission.created',
      status: { value: 'open' },
    },
    attributes: { form: 'form.name', tags: 'submission.tags' },
  });

  test('maps fields by path, with fallbacks, lookups and defaults', () => {
    const item = fromWebhook(fixture('form-submission.json'), mapping, { now });
    assert.equal(item.id, 'forms:sub_00981');
    assert.equal(item.title, 'Return 12 damaged pallets');
    assert.equal(item.priority, 'urgent');
    assert.deepEqual(item.requester, { name: 'Noah', email: 'noah@buyer.example' });
    assert.equal(item.attributes.form, 'Returns request');
    assert.equal(item.attributes.tags, '["returns"]', 'non-scalar attributes are kept as JSON text');
  });

  test('defaults apply when a path is missing or empty, and to unmapped lookup values', () => {
    const payload = fixture('form-submission.json');
    delete payload.submission.fields.topic;
    payload.submission.fields.urgency = 'whenever';
    const item = fromWebhook(payload, mapping, { now });
    assert.equal(item.title, 'Untitled request');
    assert.equal(item.priority, 'normal');
  });

  test('a lookup miss without a default is reported by validation', () => {
    const strict = defineMapping({ source: 'forms', fields: { externalId: 'id', title: 't', priority: { path: 'p', map: { asap: 'urgent' } } } });
    assert.throws(() => fromWebhook({ id: 1, t: 'x', p: 'whenever' }, strict, { now }), (err) => err.errors[0].path === '/priority');
  });

  test('an undefined mapping is accepted and checked on use', () => {
    const item = fromWebhook({ id: 7, t: 'Hello' }, { source: 'raw', fields: { externalId: 'id', title: 't' } }, { now });
    assert.equal(item.id, 'raw:7');
  });

  test('mapping mistakes are caught when the mapping is defined', () => {
    const bad = [
      [{ fields: { externalId: 'a', title: 'b' } }, 'source'],
      [{ source: 'Forms', fields: { externalId: 'a', title: 'b' } }, 'source'],
      [{ source: 'f', fields: { title: 'b' } }, 'externalId'],
      [{ source: 'f', fields: { externalId: 'a' } }, 'title'],
      [{ source: 'f', fields: { externalId: 'a', title: 'b', owner: 'c' } }, 'owner'],
      [{ source: 'f', fields: { externalId: 'a', title: { path: 'b', value: 'c' } } }, 'title'],
      [{ source: 'f', fields: { externalId: 'a', title: { pth: 'b' } } }, 'title'],
      [{ source: 'f', fields: { externalId: 'a', title: { map: {} } } }, 'title'],
      [{ source: 'f', fields: { externalId: 'a', title: 'b' }, currency: 'dollars' }, 'currency'],
    ];
    for (const [m, field] of bad) {
      assert.throws(() => defineMapping(m), (err) => err instanceof MappingError && err.field === field, JSON.stringify(m));
    }
  });

  test('refuses a non-object payload', () => {
    assert.throws(() => fromWebhook([], mapping), (err) => err.code === 'invalid_payload');
  });
});

describe('CSV adapter', () => {
  const mapping = {
    source: 'orders-csv',
    kind: 'order',
    currency: 'USD',
    fields: {
      externalId: 'order_id',
      title: 'summary',
      requester: 'customer',
      status: { path: 'status', map: { 'in progress': 'in_progress', open: 'open', shipped: 'done' } },
      amount: 'total',
      createdAt: 'created',
    },
  };

  test('imports the sample file: good rows in, bad rows reported with their line', () => {
    const text = readFileSync(new URL('../examples/payloads/orders.csv', import.meta.url), 'utf8');
    const { items, errors } = fromCsv(text, { ...mapping, fields: { ...mapping.fields, body: 'notes' } }, { now });
    assert.deepEqual(items.map((i) => i.id), ['orders-csv:SO-55120', 'orders-csv:SO-55121', 'orders-csv:SO-55122']);
    assert.deepEqual(items[0].amount, { value: 1240, currency: 'USD' });
    assert.equal(items[1].title, 'Pallet jack, "heavy duty" variant');
    assert.equal(items[1].body, 'Two lines:\nfirst line\nsecond line');
    assert.equal(items[2].status, 'done');
    assert.equal(items[2].requester, undefined);
    assert.deepEqual(errors.map((e) => [e.line, e.errors[0].path]), [[7, '/createdAt']]);
  });

  test('a row with the wrong number of fields is reported, the rest still import', () => {
    const text = 'order_id,summary,total\nA1,Tape,5\nA2,Labels\nA3,Film,7\n';
    const { items, errors } = fromCsv(text, mapping, { now });
    assert.equal(items.length, 2);
    assert.deepEqual(errors, [{ line: 3, code: 'column_count', message: 'Expected 3 fields, found 2' }]);
  });

  test('header names are trimmed; duplicate or empty headers are refused', () => {
    assert.equal(fromCsv(' order_id , summary \nA1,Tape', mapping, { now }).items[0].title, 'Tape');
    assert.throws(() => fromCsv('order_id,order_id\n1,2', mapping), (err) => err instanceof CsvParseError && err.column === 2);
    assert.throws(() => fromCsv('order_id,,summary\n1,2,3', mapping), CsvParseError);
  });

  test('a header-only or empty file imports nothing', () => {
    assert.deepEqual(fromCsv('order_id,summary\n', mapping), { items: [], errors: [] });
    assert.deepEqual(fromCsv('', mapping), { items: [], errors: [] });
  });

  test('column names containing dots are read as plain names', () => {
    const { items } = fromCsv('ref.no,title.text\nR-1,Pallets', { source: 'sheet', fields: { externalId: 'ref.no', title: 'title.text' } }, { now });
    assert.equal(items[0].id, 'sheet:R-1');
  });

  test('semicolon-separated files', () => {
    const { items } = fromCsv('order_id;summary\nA1;Tape, clear', mapping, { now, delimiter: ';' });
    assert.equal(items[0].title, 'Tape, clear');
  });
});
