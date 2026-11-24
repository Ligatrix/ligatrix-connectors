// Type declarations for @ligatrix/connectors.

// ---------- WorkItem ----------

export type WorkItemKind = 'task' | 'issue' | 'comment' | 'deal' | 'contact' | 'ticket' | 'request' | 'order';
export type WorkItemStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'cancelled';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Person {
  name?: string;
  email?: string;
}

export interface Amount {
  value: number;
  /** ISO 4217 code, upper case. */
  currency: string;
}

export interface WorkItem {
  /** "<source>:<externalId>" */
  id: string;
  source: string;
  externalId: string;
  parentId?: string;
  kind: WorkItemKind;
  title: string;
  body?: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  requester?: Person;
  assignee?: Person;
  labels: string[];
  url?: string;
  amount?: Amount;
  /** RFC 3339 UTC, e.g. "2026-11-24T09:00:00.000Z" */
  createdAt: string;
  updatedAt: string;
  receivedAt: string;
  attributes?: Record<string, string | number | boolean | null>;
}

/** What adapters hand to normalize(): loose input, cleaned and checked there. */
export interface WorkItemInput {
  source: string;
  externalId: string | number;
  parentId?: string;
  kind?: string;
  title: string;
  body?: string | null;
  status?: string;
  priority?: string;
  requester?: Person | string | null;
  assignee?: Person | string | null;
  labels?: Array<string | { name: string } | null> | string | null;
  url?: string | null;
  amount?: { value: number | string; currency?: string } | null;
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
  receivedAt?: string | number | Date;
  attributes?: Record<string, unknown>;
}

export interface NormalizeOptions {
  /** Clock for receivedAt; defaults to the current time. */
  now?: () => Date | number | string;
}

export const workItemSchema: JsonSchema;
export const KINDS: readonly WorkItemKind[];
export const STATUSES: readonly WorkItemStatus[];
export const PRIORITIES: readonly WorkItemPriority[];

export function normalize(partial: WorkItemInput, options?: NormalizeOptions): WorkItem;
export function validateWorkItem(item: unknown): ValidationResult;
export function toTimestamp(value: unknown): unknown;
export function toPerson(value: unknown): Person | undefined;

// ---------- Validator ----------

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export type JsonSchema = boolean | {
  $schema?: string;
  $id?: string;
  $comment?: string;
  title?: string;
  description?: string;
  type?: JsonType | JsonType[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  format?: 'date-time' | 'email' | 'uri';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [annotation: string]: unknown;
};

export interface SchemaIssue {
  /** JSON Pointer to the failing value; "" is the root. */
  path: string;
  keyword: string;
  message: string;
  params?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: SchemaIssue[];
}

export function compile(schema: JsonSchema): (value: unknown) => ValidationResult;
export function validate(schema: JsonSchema, value: unknown): ValidationResult;
export function assertValid<T>(schema: JsonSchema, value: T): T;
export function isDateTime(value: string): boolean;
export function isEmail(value: string): boolean;
export function isUri(value: string): boolean;

// ---------- Errors ----------

export class ConnectorError extends Error {
  code: string;
}
export class ValidationError extends ConnectorError {
  code: 'validation_failed';
  errors: SchemaIssue[];
  constructor(errors: SchemaIssue[], message?: string);
}
export class SchemaError extends ConnectorError {
  code: 'invalid_schema';
  path: string;
}
export class AdapterError extends ConnectorError {
  /** e.g. "unsupported_event", "invalid_payload", "unknown_stage", "unknown_status", "unknown_priority" */
  code: string;
  path: string;
}
export class MappingError extends ConnectorError {
  code: 'invalid_mapping';
  field: string;
}
export class CsvParseError extends ConnectorError {
  code: 'csv_parse_error';
  line: number;
  column: number;
}

// ---------- Paths and mappings ----------

export function parsePath(path: string): Array<string | number>;
export function getPath(object: unknown, path: string): unknown;

export type MappableField =
  | 'externalId' | 'parentId' | 'kind' | 'title' | 'body' | 'status' | 'priority' | 'requester'
  | 'assignee' | 'labels' | 'url' | 'amount' | 'createdAt' | 'updatedAt';

export type FieldSpec =
  | string
  | {
    /** A path, or several tried in order; the first non-empty value wins. */
    path?: string | string[];
    /** A constant value (cannot be combined with path). */
    value?: unknown;
    /** Case-insensitive lookup applied to the raw value. */
    map?: Record<string, unknown>;
    /** Used when nothing is found, or when a mapped value has no entry in map. */
    default?: unknown;
  };

export interface Mapping {
  source: string;
  kind?: WorkItemKind;
  /** Currency applied to a mapped plain amount. */
  currency?: string;
  fields: Partial<Record<MappableField, FieldSpec>> & { externalId: FieldSpec; title: FieldSpec };
  attributes?: Record<string, FieldSpec>;
}

export interface CompiledMapping {
  readonly compiled: true;
  readonly source: string;
}

export const MAPPABLE_FIELDS: readonly MappableField[];
export function defineMapping(mapping: Mapping): CompiledMapping;
export function applyMapping(
  mapping: Mapping | CompiledMapping,
  record: unknown,
  read: (record: unknown, path: string) => unknown,
): WorkItemInput;

// ---------- CSV ----------

export interface CsvOptions {
  /** A single character; defaults to ",". */
  delimiter?: string;
}

export function parseCsv(text: string, options?: CsvOptions): string[][];
export function parseCsvRecords(text: string, options?: CsvOptions): Array<{ line: number; fields: string[] }>;

// ---------- Adapters ----------

export function fromWebhook(payload: object, mapping: Mapping | CompiledMapping, options?: NormalizeOptions): WorkItem;

export interface GitHubOptions extends NormalizeOptions {
  /** The X-GitHub-Event header. */
  event: 'issues' | 'issue_comment' | string;
  /** The X-GitHub-Delivery header, kept as an attribute. */
  deliveryId?: string;
}
export function fromGitHub(payload: object, options: GitHubOptions): WorkItem;
export function priorityFromLabels(labels: Array<string | { name?: string }>): WorkItemPriority | undefined;

export interface CrmOptions extends NormalizeOptions {
  /** Defaults to "crm". */
  source?: string;
  /** Extra or replacement stage → status entries; keys are lower case with underscores. */
  stageMap?: Record<string, WorkItemStatus>;
  /** Currency for deals that do not carry one. */
  currency?: string;
}
export const DEFAULT_STAGE_MAP: Readonly<Record<string, WorkItemStatus>>;
export function fromCrmEvent(payload: object, options?: CrmOptions): WorkItem;

export interface HelpdeskOptions extends NormalizeOptions {
  /** Defaults to "helpdesk". */
  source?: string;
}
export const TICKET_STATUS_MAP: Readonly<Record<string, WorkItemStatus>>;
export const TICKET_PRIORITY_MAP: Readonly<Record<string, WorkItemPriority>>;
export function fromHelpdeskEvent(payload: object, options?: HelpdeskOptions): WorkItem;

export interface CsvRowError {
  /** The line the row starts on (the header is line 1). */
  line: number;
  code: string;
  message: string;
  errors?: SchemaIssue[];
}
export function fromCsv(
  text: string,
  mapping: Mapping | CompiledMapping,
  options?: NormalizeOptions & CsvOptions,
): { items: WorkItem[]; errors: CsvRowError[] };

// ---------- Signatures ----------

export type Secret = string | Uint8Array;
export type RawBody = string | Uint8Array;

export function signHmac(secret: Secret, payload: RawBody): string;
export function verifyHmac(secret: Secret, payload: RawBody, signature: string | undefined): boolean;
export function safeEqualHex(a: string, b: string): boolean;
export function signGitHub(secret: Secret, payload: RawBody): string;
export function verifyGitHubSignature(secret: Secret, payload: RawBody, header: string | undefined): boolean;
export function signTimestamped(secret: Secret, payload: RawBody, options?: { timestamp?: number }): string;
export function parseTimestampedHeader(header: string | undefined): { timestamp: number; signatures: string[] } | null;

export interface VerifyTimestampedOptions {
  /** Seconds either side of now; defaults to 300. */
  toleranceSeconds?: number;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
  /** When given, a signature accepted once is refused afterwards. */
  replayStore?: Pick<TtlStore, 'setIfAbsent'>;
}
export type VerifyTimestampedResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: 'malformed' | 'outside_tolerance' | 'mismatch' | 'replayed' };

export function verifyTimestamped(
  secret: Secret,
  payload: RawBody,
  header: string | undefined,
  options?: VerifyTimestampedOptions,
): Promise<VerifyTimestampedResult>;

// ---------- Idempotency ----------

type MaybePromise<T> = T | Promise<T>;

export interface TtlStore {
  /** Atomically stores the value only if the key is absent or expired; true if stored. */
  setIfAbsent(key: string, value: unknown, ttlMs: number): MaybePromise<boolean>;
  get(key: string): MaybePromise<unknown>;
  delete(key: string): MaybePromise<boolean>;
}

export class MemoryTtlStore implements TtlStore {
  constructor(options?: { now?: () => number; maxEntries?: number });
  get(key: string): unknown;
  has(key: string): boolean;
  set(key: string, value: unknown, ttlMs: number): void;
  setIfAbsent(key: string, value: unknown, ttlMs: number): boolean;
  delete(key: string): boolean;
  prune(): number;
  readonly size: number;
}

export interface SourceRef {
  source: string;
  externalId: string | number;
}

export interface Deduper {
  readonly store: TtlStore;
  readonly ttlMs: number;
  key(item: SourceRef): string;
  firstSeen(item: SourceRef): Promise<boolean>;
  forget(item: SourceRef): Promise<boolean>;
  run<T>(item: SourceRef, handler: (item: SourceRef) => T | Promise<T>):
    Promise<{ status: 'processed'; result: T } | { status: 'duplicate' }>;
}

export function dedupeKey(source: string | number, externalId: string | number, namespace?: string): string;
export function createDeduper(options?: { store?: TtlStore; ttlMs?: number; namespace?: string }): Deduper;
