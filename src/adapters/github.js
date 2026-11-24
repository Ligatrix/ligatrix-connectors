/**
 * GitHub "issues" and "issue_comment" webhook events.
 *
 * Issue ids are "<owner>/<repo>#<number>", so an issue keeps the same
 * WorkItem id across every event about it. Comments get their own id and a
 * parentId pointing at the issue's WorkItem id.
 */

import { AdapterError } from '../errors.js';
import { normalize } from '../work-item.js';

const PRIORITY_LABEL = /^(?:priority\s*[:/-]\s*(urgent|critical|high|medium|normal|low)|(p[0-3]))$/i;
const PRIORITY_WORDS = {
  urgent: 'urgent', critical: 'urgent', p0: 'urgent',
  high: 'high', p1: 'high',
  medium: 'normal', normal: 'normal', p2: 'normal',
  low: 'low', p3: 'low',
};
const RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

function need(value, path, type = 'object') {
  const ok = type === 'object'
    ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'number' ? Number.isInteger(value) : typeof value === type && value !== '';
  if (!ok) throw new AdapterError('invalid_payload', `GitHub payload is missing ${path}`, path);
  return value;
}

/**
 * Reads a priority from labels such as "priority: high" or "P1". When several
 * match, the most urgent wins. Returns undefined when no label says.
 */
export function priorityFromLabels(labels) {
  let best;
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    const m = typeof name === 'string' ? PRIORITY_LABEL.exec(name.trim()) : null;
    if (!m) continue;
    const priority = PRIORITY_WORDS[(m[1] ?? m[2]).toLowerCase()];
    if (best === undefined || RANK[priority] > RANK[best]) best = priority;
  }
  return best;
}

function issueStatus(issue) {
  if (issue.state === 'closed') return issue.state_reason === 'not_planned' ? 'cancelled' : 'done';
  return 'open';
}

function login(user) {
  return user && typeof user.login === 'string' ? { name: user.login } : undefined;
}

/**
 * @param {object} payload the parsed webhook body
 * @param {{ event: string, deliveryId?: string, now?: () => Date }} options
 *   `event` is the X-GitHub-Event header, `deliveryId` the X-GitHub-Delivery header.
 */
export function fromGitHub(payload, options = {}) {
  const { event, deliveryId } = options;
  if (event !== 'issues' && event !== 'issue_comment') {
    throw new AdapterError('unsupported_event', `GitHub event "${event}" is not supported; expected "issues" or "issue_comment"`);
  }
  need(payload, '(payload)');
  const repo = need(payload.repository?.full_name, 'repository.full_name', 'string');
  const issue = need(payload.issue, 'issue');
  const number = need(issue.number, 'issue.number', 'number');
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const issueExternalId = `${repo}#${number}`;
  const attributes = {
    repository: repo,
    action: typeof payload.action === 'string' ? payload.action : undefined,
    deliveryId,
  };

  if (event === 'issues') {
    return normalize({
      source: 'github',
      externalId: issueExternalId,
      kind: 'issue',
      title: issue.title,
      body: issue.body,
      status: issueStatus(issue),
      priority: priorityFromLabels(labels),
      requester: login(issue.user),
      assignee: login(issue.assignee ?? issue.assignees?.[0]),
      labels,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      attributes: { ...attributes, number },
    }, options);
  }

  const comment = need(payload.comment, 'comment');
  const commentId = need(comment.id, 'comment.id', 'number');
  return normalize({
    source: 'github',
    externalId: `${issueExternalId}/comments/${commentId}`,
    parentId: `github:${issueExternalId}`,
    kind: 'comment',
    title: `Comment on #${number}: ${issue.title ?? ''}`,
    body: comment.body,
    status: payload.action === 'deleted' ? 'cancelled' : 'open',
    priority: priorityFromLabels(labels),
    requester: login(comment.user),
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    attributes: { ...attributes, issueNumber: number, onPullRequest: Boolean(issue.pull_request) },
  }, options);
}
