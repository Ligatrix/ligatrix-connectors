// Normalises every sample payload in examples/payloads and prints the results.
// Run from the repository root: node examples/run.mjs
//
// Sample data belongs to Corvane Supply Co., a fictional distributor used in this demo.

import { readFileSync } from 'node:fs';
import {
  createDeduper,
  defineMapping,
  fromCrmEvent,
  fromCsv,
  fromGitHub,
  fromHelpdeskEvent,
  fromWebhook,
  signGitHub,
  verifyGitHubSignature,
} from '../src/index.js';

const read = (name) => readFileSync(new URL(`./payloads/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(read(name));
const options = { now: () => new Date('2026-11-24T09:00:00Z') };
const show = (heading, value) => console.log(`\n## ${heading}\n${JSON.stringify(value, null, 2)}`);

// GitHub: verify the signature on the raw body first, then normalise.
const secret = 'demo-secret-not-for-production';
const rawIssue = read('github-issue.json');
const header = signGitHub(secret, rawIssue); // what GitHub would send
console.log(`GitHub signature valid: ${verifyGitHubSignature(secret, rawIssue, header)}`);
const issue = fromGitHub(JSON.parse(rawIssue), { event: 'issues', deliveryId: 'd-0001', ...options });
show('GitHub issue', issue);
show('GitHub issue comment', fromGitHub(json('github-issue-comment.json'), { event: 'issue_comment', ...options }));

show('CRM deal', fromCrmEvent(json('crm-deal.json'), options));
show('CRM contact', fromCrmEvent(json('crm-contact.json'), options));
show('Helpdesk ticket', fromHelpdeskEvent(json('helpdesk-ticket.json'), options));

const formMapping = defineMapping({
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
  },
  attributes: { form: 'form.name' },
});
show('Generic webhook (form submission)', fromWebhook(json('form-submission.json'), formMapping, options));

const orderMapping = {
  source: 'orders-csv',
  kind: 'order',
  currency: 'USD',
  fields: {
    externalId: 'order_id',
    title: 'summary',
    body: 'notes',
    requester: 'customer',
    status: { path: 'status', map: { 'in progress': 'in_progress', open: 'open', shipped: 'done' } },
    amount: 'total',
    createdAt: 'created',
  },
};
const { items, errors } = fromCsv(read('orders.csv'), orderMapping, options);
show(`CSV orders (${items.length} imported, ${errors.length} rejected)`, { items, errors });

// Idempotency: the same issue delivered twice is handled once.
const deduper = createDeduper();
const first = await deduper.run(issue, async () => 'saved');
const second = await deduper.run(issue, async () => 'saved');
console.log(`\nFirst delivery: ${first.status}. Second delivery: ${second.status}.`);
