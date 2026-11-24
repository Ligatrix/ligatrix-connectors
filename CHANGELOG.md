# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-24

### Added

- `WorkItem` JSON Schema (`schemas/work-item.schema.json`) and a single `normalize()` that cleans, defaults and validates every item.
- JSON Schema subset validator: `type`, `required`, `properties`, `enum`, `format` (`date-time`, `email`, `uri`),
  `minLength`, `maxLength`, `pattern`, `items`, `additionalProperties`, with JSON Pointer error paths.
- Adapters: generic webhook with declarative field mappings, GitHub `issues` and `issue_comment`, CRM deal and contact
  events, helpdesk ticket events, and CSV exports.
- RFC 4180 CSV parser with line and column error reporting.
- Webhook signatures: HMAC-SHA256, GitHub `X-Hub-Signature-256`, and a timestamped `t=…,v1=…` scheme with a tolerance
  window, secret rotation and replay rejection.
- Idempotency: `createDeduper()` keyed by source and external id, a TTL store interface and `MemoryTtlStore`.
- Hand-written TypeScript declarations (`src/index.d.ts`).
- Sample payloads and `examples/run.mjs`.

[Unreleased]: https://github.com/Ligatrix/ligatrix-connectors/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ligatrix/ligatrix-connectors/releases/tag/v1.0.0
