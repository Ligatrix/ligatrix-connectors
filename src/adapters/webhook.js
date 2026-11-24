import { AdapterError } from '../errors.js';
import { applyMapping } from '../mapping.js';
import { getPath } from '../paths.js';
import { normalize } from '../work-item.js';

/**
 * Maps any JSON webhook body to a WorkItem using a field mapping (see
 * defineMapping). Paths are dot paths into the payload.
 */
export function fromWebhook(payload, mapping, options = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdapterError('invalid_payload', 'Webhook payload must be a JSON object');
  }
  return normalize(applyMapping(mapping, payload, getPath), options);
}
