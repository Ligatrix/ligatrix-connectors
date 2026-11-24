/**
 * CRM-style deal and contact events.
 *
 * Expected envelope (the common shape of CRM webhooks):
 *
 *   {
 *     "id": "evt_9f2c",                  // event id, kept as an attribute
 *     "type": "deal.updated",            // deal.created|updated|stage_changed|deleted,
 *                                        // contact.created|updated|deleted
 *     "occurred_at": "2026-11-20T14:05:00Z",
 *     "data": { ...the deal or contact... }
 *   }
 *
 * A deal's stage becomes the WorkItem status through `stageMap`; an unknown
 * stage is an error rather than a silent "open", so a new pipeline stage is
 * noticed the first time it appears.
 */

import { AdapterError } from '../errors.js';
import { normalize } from '../work-item.js';

export const DEFAULT_STAGE_MAP = Object.freeze({
  lead: 'open',
  new: 'open',
  qualified: 'open',
  discovery: 'in_progress',
  proposal: 'in_progress',
  negotiation: 'in_progress',
  contract_sent: 'waiting',
  won: 'done',
  closed_won: 'done',
  lost: 'cancelled',
  closed_lost: 'cancelled',
});

const TYPE = /^(deal|contact)\.(created|updated|stage_changed|deleted)$/;

function stageKey(stage) {
  return String(stage).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * @param {object} payload
 * @param {{ source?: string, stageMap?: Record<string,string>, now?: () => Date }} [options]
 */
export function fromCrmEvent(payload, options = {}) {
  if (payload === null || typeof payload !== 'object') {
    throw new AdapterError('invalid_payload', 'CRM payload must be a JSON object');
  }
  const match = TYPE.exec(payload.type ?? '');
  if (!match) {
    throw new AdapterError('unsupported_event', `CRM event type "${payload.type}" is not supported`, 'type');
  }
  const [, object, action] = match;
  const data = payload.data;
  if (data === null || typeof data !== 'object' || data.id === undefined || data.id === null || data.id === '') {
    throw new AdapterError('invalid_payload', 'CRM payload is missing data.id', 'data.id');
  }
  const source = options.source ?? 'crm';
  const attributes = { eventId: payload.id, eventType: payload.type };

  if (object === 'deal') {
    const stageMap = { ...DEFAULT_STAGE_MAP, ...(options.stageMap ?? {}) };
    let status = 'open';
    if (action === 'deleted') {
      status = 'cancelled';
    } else if (data.stage !== undefined && data.stage !== null) {
      status = stageMap[stageKey(data.stage)];
      if (status === undefined) {
        throw new AdapterError('unknown_stage', `Deal stage "${data.stage}" has no status; add it to stageMap`, 'data.stage');
      }
    }
    return normalize({
      source,
      externalId: `deal/${data.id}`,
      kind: 'deal',
      title: data.name,
      body: data.description,
      status,
      priority: data.priority,
      requester: data.contact,
      assignee: data.owner,
      labels: data.tags,
      url: data.url,
      amount: data.amount === undefined || data.amount === null
        ? undefined
        : { value: data.amount, currency: data.currency ?? options.currency },
      createdAt: data.created_at ?? payload.occurred_at,
      updatedAt: data.updated_at ?? payload.occurred_at,
      attributes: { ...attributes, stage: data.stage, closeDate: data.close_date },
    }, options);
  }

  const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.name;
  return normalize({
    source,
    externalId: `contact/${data.id}`,
    kind: 'contact',
    title: fullName || data.email,
    status: action === 'deleted' ? 'cancelled' : 'open',
    requester: { name: fullName, email: data.email },
    assignee: data.owner,
    labels: data.tags,
    url: data.url,
    createdAt: data.created_at ?? payload.occurred_at,
    updatedAt: data.updated_at ?? payload.occurred_at,
    attributes: { ...attributes, company: data.company, lifecycle: data.lifecycle_stage },
  }, options);
}
