# Internal monitoring protocol v1

Protected endpoints require `Authorization: Bearer <token>`. HTTPS is required except explicitly allowed private-network HTTP. Desktop and Agent do not follow redirects.

Admin and Agent scopes are separate. Per-node tokens only submit that node's reports. The server stores token hashes; plaintext is returned on create/rotation only. The Go endpoints below listen on loopback inside the unified cloud. Desktop requests use account authentication at `/v1/monitor/...`; Agents submit only to `/v1/monitor/reports`, with `serverUrl` ending in `/v1/monitor`. No standalone public routes are provided.

| Endpoint | Role / result |
| --- | --- |
| GET /healthz | Public; service name and protocol version only |
| GET /v1/nodes | Admin; metadata, latest metrics, period and lifetime usage |
| POST /v1/nodes | Admin; body name/group/asset; returns node/token |
| PUT /v1/nodes/{id} | Admin; update name/group/asset; history preserved |
| POST /v1/nodes/{id}/token | Admin; rotate node token |
| GET /v1/nodes/{id}/history?hours=1 | Admin; hours range 1..744 |
| GET /v1/alerts | Admin; latest 200 events |
| POST /v1/reports | Agent; returns ack sequence |

Reports contain epoch, sequence, timestamp (Unix milliseconds), upload/download cumulative observed bytes, incomplete flag, and a metrics object matching desktop ServerMetrics. Rates are bytes per second. The persistent Agent ledger starts at installation baseline. Retries or older sequence numbers do not count volume twice. Counter regression is rejected.

A new ledger epoch preserves earlier lifetime totals. Raw samples and stream offsets commit in one transaction. Sequence gaps and Agent-detected resets mark incomplete coverage. First installation does not reconstruct earlier traffic. Monthly totals use raw increments, not integrated chart rates.

Monthly boundaries use reset day 1..31 (clamped at month end) and an IANA timezone. Initial balances apply only if initialPeriod matches that cycle's local start date. After queue overflow, cumulative volume is recovered but its precise allocation across the missing interval is approximate and flagged incomplete.

History returns latest resource metrics within each display bucket plus summed byte increments. One-hour queries use 10-second buckets; up to 24h use minute buckets; longer ranges use hourly buckets.

Webhook body: id, nodeId, kind, message, timestamp, delivered. Receivers should deduplicate by instance and event id. No secrets or process commands are included. Retry after ambiguous delivery may produce duplicates.

Expiry and automatic payment are asset metadata; no provider payment or automatic date extension is performed.

Storage retention: raw samples 24 hours, minute samples 32 days; compaction preserves traffic sums and supports late backfill.
