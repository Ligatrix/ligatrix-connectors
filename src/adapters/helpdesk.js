/**
 * Helpdesk-style ticket events.
 *
 * Expected envelope:
 *
 *   {
 *     "event": "ticket.updated",          // ticket.created|updated|solved|deleted
 *     "ticket": {
 *       "id": 4821, "subject": "...", "description": "...",
 *       "status": "pending", "priority": "high",
 *       "requester": { "name": "...", "email": "..." }, "assignee": null,
 *       "tags": ["billing"], "channel": "email",
 *       "created_at": "...", "updated_at": "...", "url": "..."
 *     }
 *   }
 */

import { AdapterError } from '../errors.js';
import { normalize } from '../work-item.js';

export const TICKET_STATUS_MAP = Object.freeze({
  new: 'open',
  open: 'open',
  in_progress: 'in_progress',
  pending: 'waiting',
  on_hold: 'waiting',
  hold: 'waiting',
  solved: 'done',
  resolved: 'done',
  closed: 'done',
});

export const TICKET_PRIORITY_MAP = Object.freeze({
  low: 'low',
  normal: 'normal',
  medium: 'normal',
  high: 'high',
  urgent: 'urgent',
  critical: 'urgent',
});

const EVENT = /^ticket\.(created|updated|solved|deleted)$/;

function lookup(table, value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!Object.hasOwn(table, key)) {
    throw new AdapterError(`unknown_${field}`, `Ticket ${field} "${value}" is not recognised`, `ticket.${field}`);
  }
  return table[key];
}

/**
 * @param {object} payload
 * @param {{ source?: string, now?: () => Date }} [options]
 */
export function fromHelpdeskEvent(payload, options = {}) {
  if (payload === null || typeof payload !== 'object') {
    throw new AdapterError('invalid_payload', 'Helpdesk payload must be a JSON object');
  }
  const match = EVENT.exec(payload.event ?? '');
  if (!match) {
    throw new AdapterError('unsupported_event', `Helpdesk event "${payload.event}" is not supported`, 'event');
  }
  const ticket = payload.ticket;
  if (ticket === null || typeof ticket !== 'object' || ticket.id === undefined || ticket.id === null || ticket.id === '') {
    throw new AdapterError('invalid_payload', 'Helpdesk payload is missing ticket.id', 'ticket.id');
  }
  const action = match[1];
  const status = action === 'deleted'
    ? 'cancelled'
    : action === 'solved' ? 'done' : lookup(TICKET_STATUS_MAP, ticket.status, 'status');

  return normalize({
    source: options.source ?? 'helpdesk',
    externalId: String(ticket.id),
    kind: 'ticket',
    title: ticket.subject,
    body: ticket.description,
    status,
    priority: lookup(TICKET_PRIORITY_MAP, ticket.priority, 'priority'),
    requester: ticket.requester,
    assignee: ticket.assignee,
    labels: ticket.tags,
    url: ticket.url,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    attributes: { event: payload.event, channel: ticket.channel, sourceStatus: ticket.status },
  }, options);
}
