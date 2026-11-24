# ligatrix-connectors

Bring events from the systems a company already uses into one consistent, validated `WorkItem` shape.

![CI](https://github.com/Ligatrix/ligatrix-connectors/actions/workflows/ci.yml/badge.svg)

## Why

Every system speaks differently. GitHub sends an issue with `state: "closed"` and a `state_reason`; the CRM sends a deal whose
`stage` is `"Proposal"` and whose amount is the string `"48,500.00"`; the helpdesk sends a ticket that is `"pending"` with a
timestamp in epoch seconds; the operations team exports a spreadsheet where one cell holds three lines of notes. Each one names
the person differently, writes dates differently and means something slightly different by "open".

An internal system that reads all of them directly ends up with that translation scattered through its code, and every report
has to know every dialect. This library does the translation once, at the edge: each inbound event becomes a `WorkItem` with
the same fields, the same status and priority vocabulary, UTC timestamps and a stable id. It also covers the plumbing around it:
checking webhook signatures, recognising re-delivered events and reporting bad rows precisely instead of failing a whole import.

No dependencies. Node.js 20 or later.

## Quick start

From the repository root:

```sh
npm test
node examples/run.mjs
npm run lint
```

`examples/run.mjs` reads every sample in `examples/payloads/` (GitHub, CRM, helpdesk, a form webhook and a CSV export from
Corvane Supply Co., a fictional distributor used in this demo) and prints the normalised results.

## The WorkItem shape

Defined in [`schemas/work-item.schema.json`](schemas/work-item.schema.json) and typed in [`src/index.d.ts`](src/index.d.ts).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Always `"<source>:<externalId>"`. The same record in the source keeps the same id across events. |
| `source` | string | Lower case, e.g. `github`, `crm`, `helpdesk`, `orders-csv`. |
| `externalId` | string | The identifier in the source system. |
| `parentId` | string? | The `id` of the item this one belongs to (a comment's issue). |
| `kind` | enum | `task`, `issue`, `comment`, `deal`, `contact`, `ticket`, `request`, `order` |
| `title` | string | Whitespace collapsed, 1 to 300 characters (longer titles are shortened with "…"). |
| `body` | string? | Trimmed, line breaks normalised to `\n`. |
| `status` | enum | `open`, `in_progress`, `waiting`, `done`, `cancelled` |
| `priority` | enum | `low`, `normal`, `high`, `urgent` |
| `requester`, `assignee` | `{ name?, email? }`? | Email lower-cased and checked. Accepts `"Dana <dana@corvane.example>"`. |
| `labels` | string[] | Empty entries dropped, duplicates removed case-insensitively, order kept. |
| `url` | string? | Absolute URI. |
| `amount` | `{ value, currency }`? | Number and ISO 4217 code; `"$1,240.50"` becomes `1240.5`. |
| `createdAt`, `updatedAt`, `receivedAt` | string | RFC 3339 UTC with milliseconds. |
| `attributes` | object? | Source-specific facts worth keeping, as flat scalars. |

Every adapter goes through one function, `normalize()`, which fills defaults, cleans values and validates the result against the
schema. If anything is wrong it throws a `ValidationError` listing every problem with a JSON Pointer path, so the caller sees all
of them at once.

## Adapters

All adapters accept an optional `now` clock, used for `receivedAt`. The outputs below are from `node examples/run.mjs`.

### Helpdesk ticket

Input (`examples/payloads/helpdesk-ticket.json`):

```json
{
  "event": "ticket.updated",
  "ticket": {
    "id": 4821,
    "subject": "Invoice  shows the wrong\nshipping address",
    "description": "Our invoice INV-2207 lists the old depot address.",
    "status": "pending",
    "priority": "urgent",
    "requester": { "name": "Mia", "email": "mia@buyer.example" },
    "assignee": { "name": "Sam", "email": "sam@corvane.example" },
    "tags": ["billing", "Billing", "address"],
    "channel": "email",
    "created_at": "2026-11-23 16:02:10",
    "updated_at": 1795452300,
    "url": "https://help.corvane.example/tickets/4821"
  }
}
```

```js
import { fromHelpdeskEvent } from '@ligatrix/connectors';

const item = fromHelpdeskEvent(payload);
```

Output:

```json
{
  "id": "helpdesk:4821",
  "source": "helpdesk",
  "externalId": "4821",
  "kind": "ticket",
  "title": "Invoice shows the wrong shipping address",
  "body": "Our invoice INV-2207 lists the old depot address.",
  "status": "waiting",
  "priority": "urgent",
  "requester": { "name": "Mia", "email": "mia@buyer.example" },
  "assignee": { "name": "Sam", "email": "sam@corvane.example" },
  "labels": ["billing", "address"],
  "url": "https://help.corvane.example/tickets/4821",
  "createdAt": "2026-11-23T16:02:10.000Z",
  "updatedAt": "2026-11-23T16:45:00.000Z",
  "receivedAt": "2026-11-24T09:00:00.000Z",
  "attributes": { "channel": "email", "event": "ticket.updated", "sourceStatus": "pending" }
}
```

Statuses `new`/`open` become `open`, `pending`/`on_hold` become `waiting`, `solved`/`closed` become `done`. A status or
priority the adapter does not recognise throws an `AdapterError` (`unknown_status`, `unknown_priority`) rather than guessing.

### GitHub issues and comments

```js
import { fromGitHub, verifyGitHubSignature } from '@ligatrix/connectors';

// rawBody: the request body exactly as received
if (!verifyGitHubSignature(process.env.GITHUB_WEBHOOK_SECRET, rawBody, req.headers['x-hub-signature-256'])) {
  return res.writeHead(401).end();
}
const item = fromGitHub(JSON.parse(rawBody), {
  event: req.headers['x-github-event'],          // "issues" or "issue_comment"
  deliveryId: req.headers['x-github-delivery'],
});
```

For `examples/payloads/github-issue.json` (an open issue labelled `bug`, `warehouse`, `priority: high`):

```json
{
  "id": "github:corvane-supply/ops-portal#214",
  "source": "github",
  "externalId": "corvane-supply/ops-portal#214",
  "kind": "issue",
  "title": "Pick list prints twice for split orders",
  "body": "When an order ships from two warehouses the pick list is printed at both sites.\nExpected: one list per site.",
  "status": "open",
  "priority": "high",
  "requester": { "name": "dana-corvane" },
  "assignee": { "name": "omar-corvane" },
  "labels": ["bug", "warehouse", "priority: high"],
  "url": "https://github.com/corvane-supply/ops-portal/issues/214",
  "createdAt": "2026-11-18T08:12:44.000Z",
  "updatedAt": "2026-11-20T10:03:09.000Z",
  "receivedAt": "2026-11-24T09:00:00.000Z",
  "attributes": { "action": "labeled", "deliveryId": "d-0001", "number": 214, "repository": "corvane-supply/ops-portal" }
}
```

A closed issue is `done`, or `cancelled` when closed as not planned. Priority comes from labels such as `priority: high`,
`priority/urgent` or `P0`–`P3`; the most urgent wins. A comment becomes its own item, `kind: "comment"`, with
`parentId: "github:corvane-supply/ops-portal#214"`.

### CRM deals and contacts

```js
import { fromCrmEvent } from '@ligatrix/connectors';

const item = fromCrmEvent(payload, { stageMap: { legal_review: 'waiting' } });
```

A `deal.stage_changed` event for a deal in stage `"Proposal"` worth `"48,500.00"` `"usd"` becomes:

```json
{
  "id": "crm:deal/D-1042",
  "kind": "deal",
  "title": "Annual restock contract, north region",
  "status": "in_progress",
  "priority": "normal",
  "requester": { "name": "Priya", "email": "priya@buyer.example" },
  "assignee": { "name": "Dana", "email": "dana@corvane.example" },
  "amount": { "value": 48500, "currency": "USD" },
  "attributes": { "closeDate": "2026-12-15", "eventId": "evt_7c1a40", "eventType": "deal.stage_changed", "stage": "Proposal" }
}
```

(Some fields omitted.) Won stages are `done`, lost stages `cancelled`. An unknown stage throws `unknown_stage` so a new pipeline
stage is noticed the first time it appears; add it with `stageMap`. Deal and contact ids are prefixed (`deal/`, `contact/`) so
they never collide.

### Any other webhook: a field mapping

```js
import { defineMapping, fromWebhook } from '@ligatrix/connectors';

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

const item = fromWebhook(payload, formMapping);
```

Paths support `a.b.c`, `items[0].sku`, `items.0.sku` and `meta["key.with.dots"]`, and read only the payload's own properties.
A field spec is a path, a list of paths (first non-empty wins), a constant `value`, a case-insensitive `map` and a `default`.
`defineMapping` checks the mapping at startup, so a misspelt field name fails before the first delivery. For
`examples/payloads/form-submission.json` the result is `forms:sub_00981`, priority `urgent` (from `"ASAP"`), requester
`{ "name": "Noah", "email": "noah@buyer.example" }`.

### CSV exports

```js
import { fromCsv } from '@ligatrix/connectors';

const csv = 'order_id,summary,total\nSO-1,"Tape, clear",12.50\nSO-2,Labels\n';
const { items, errors } = fromCsv(csv, {
  source: 'orders-csv',
  kind: 'order',
  currency: 'USD',
  fields: { externalId: 'order_id', title: 'summary', amount: 'total' },
});
```

```text
items:  [ { id: 'orders-csv:SO-1', title: 'Tape, clear', amount: { value: 12.5, currency: 'USD' }, ... } ]
errors: [ { line: 3, code: 'column_count', message: 'Expected 3 fields, found 2' } ]
```

In a CSV mapping, paths are column names. The parser follows RFC 4180: quoted fields, `""` for a quote, delimiters and line
breaks inside quotes, CRLF, LF or CR endings, a leading byte order mark. Malformed text throws `CsvParseError` with the line and
column; a row that parses but does not validate is reported in `errors` with the line it starts on, and every other row is still
imported. `parseCsv(text)` is exported on its own too.

## Signature verification

Always verify the raw body as received. Parsing and re-serialising JSON changes the bytes and the signature will not match.
All comparisons use `crypto.timingSafeEqual`.

```js
import {
  verifyHmac, verifyGitHubSignature, verifyTimestamped, MemoryTtlStore,
} from '@ligatrix/connectors';

verifyHmac(secret, rawBody, hexSignature);                         // plain HMAC-SHA256, hex
verifyGitHubSignature(secret, rawBody, 'sha256=5bdcc146bf6075…');  // X-Hub-Signature-256

const replayStore = new MemoryTtlStore();
const result = await verifyTimestamped(secret, rawBody, req.headers['webhook-signature'], {
  toleranceSeconds: 300,  // default
  replayStore,            // optional: refuse a signature that was already accepted
});
// { valid: true, timestamp: 1795424400 }
// or { valid: false, reason: 'malformed' | 'outside_tolerance' | 'mismatch' | 'replayed' }
```

The timestamped scheme signs `"<t>.<body>"` and sends `t=<unix seconds>,v1=<hex>`. Several `v1` values are accepted so a
sender can sign with the old and the new secret while rotating. A replay is recorded only after the signature matches, so
forged requests cannot fill the store. `signHmac`, `signGitHub` and `signTimestamped` produce the same formats, for tests and
for outbound webhooks.

## Idempotency

Senders retry, and spreadsheets get imported twice. The deduper remembers each `(source, externalId)` pair for a TTL:

```js
import { createDeduper } from '@ligatrix/connectors';

const deduper = createDeduper({ ttlMs: 24 * 60 * 60 * 1000 });

const outcome = await deduper.run(item, async (workItem) => saveToDatabase(workItem));
// first delivery: { status: 'processed', result: … }
// re-delivery:    { status: 'duplicate' }
```

If the handler throws, the pair is forgotten so the sender's retry is handled. The store is an interface
(`setIfAbsent`, `get`, `delete`, sync or async); `MemoryTtlStore` suits one process, and a shared store such as Redis
`SET NX PX` or a table with a unique key suits several. Keys are URI-encoded so `("a:b", "c")` and `("a", "b:c")` never collide.

## The validator

The schema validator is exported for your own payloads. It supports `type`, `required`, `properties`, `enum`,
`format` (`date-time`, `email`, `uri`), `minLength`, `maxLength`, `pattern`, `items` and `additionalProperties`.

```js
import { validate } from '@ligatrix/connectors';

const schema = {
  type: 'object',
  required: ['sku', 'lines'],
  additionalProperties: false,
  properties: {
    sku: { type: 'string', pattern: '^[A-Z]{2}-\\d+$' },
    contact: { type: 'string', format: 'email' },
    lines: { type: 'array', items: { type: 'object', required: ['qty'], properties: { qty: { type: 'integer' } } } },
  },
};

const { errors } = validate(schema, { sku: 'pallet', contact: 'dana@', lines: [{ qty: 2 }, { qty: '3' }, {}], note: 'x' });
for (const e of errors) process.stdout.write(`${e.path} ${e.keyword}: ${e.message}\n`);
```

```text
/sku pattern: must match pattern ^[A-Z]{2}-\d+$
/contact format: must be a valid email
/lines/1/qty type: must be integer, got string
/lines/2/qty required: is required
/note additionalProperties: is not an allowed property
```

## Design notes

- **One normaliser.** Adapters only translate vocabulary; defaults, cleaning and validation live in `normalize()`, so a rule
  such as "timestamps are UTC" cannot drift between sources. The published JSON Schema is the same file the code validates against.
- **Strict about meaning, forgiving about format.** `"$1,240.50"`, epoch seconds and `"Dana <dana@…>"` are read; an unknown
  deal stage or ticket status is an error, because guessing a status silently corrupts every report built on it.
- **Unsupported schema keywords are refused**, not ignored. A schema with `minimum` fails to compile instead of appearing to
  enforce something it does not.
- **Times without an offset are read as UTC**, never as the server's local time, so the same export gives the same result
  on every machine. Impossible dates (30 February) are reported, not rolled into March.
- **Bad CSV rows do not sink an import.** Each row error carries its line number; structural damage (an unclosed quote)
  stops the parse with a line and column, because the rows after it cannot be trusted.
- **The in-memory store is per process.** It is bounded (`maxEntries`) and fine for one instance; use a shared store
  behind the same three-method interface when several instances receive events.

## Testing

```sh
npm test
```

Tests use `node:test` and cover the validator's keywords and error paths, timestamp and person parsing, each adapter's
success and failure paths, CSV edge cases, known HMAC vectors, tolerance and replay handling, the TTL store and the examples.

## Licence

MIT. See [LICENSE](LICENSE).

---
Built and maintained by the [Ligatrix](https://ligatrix.com) team. We build systems like this for companies: [book a call](https://ligatrix.com/contact/sales).
