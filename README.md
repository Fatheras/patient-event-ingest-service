# Patient Event Ingest Service

This NestJS service accepts patient events from third parties, persists them in
MongoDB, and processes them asynchronously. HTTP 202 is returned after the
database acknowledges the write, without waiting for the five-second simulated
processing step.

## Quick start

With Node.js 24 LTS, npm, and Docker Compose installed:

```bash
docker compose up --build -d --wait

curl --request POST http://localhost:3000/events \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: example-event-1' \
  --data '{"patientId":"patient-123","type":"observation.created","data":{"value":72},"ts":"2026-09-03T12:00:00Z"}'
```

Stop the stack with `docker compose down`; the named MongoDB volume is retained.

## API

`POST /events` requires an `Idempotency-Key` header and this JSON body:

```json
{
  "patientId": "patient-123",
  "type": "observation.created",
  "data": { "value": 72 },
  "ts": "2026-09-03T12:00:00Z"
}
```

| Response | Meaning |
| --- | --- |
| `202 Accepted` | MongoDB acknowledged the event; returns `{"eventId":"<id>","status":"accepted"}`. |
| `400 Bad Request` | The header or strict payload validation failed. |
| `409 Conflict` | The key already identifies a different normalized payload. |

The same key and normalized payload returns the original event ID without another
insert. Nested object keys are canonicalized before hashing, so property order is
irrelevant. The health check is `GET /health`.

## Architecture and trade-offs

1. Zod validates the HTTP header and payload.
2. MongoDB records a `pending` event using majority and journal acknowledgement
   with a five-second write-concern timeout; only then can the API return 202.
3. The worker atomically claims work, changes it to `processing`, and maintains a
   renewable lease with an owner and claim token.
4. Success records `processedAt` and `{"outcome":"processed"}`. Failure returns
   to `pending` with capped exponential backoff and its last error; expired leases
   are reclaimable.

Attempts, leases, errors, queue state, and outcomes remain in the single `events`
collection. MongoDB therefore satisfies the assignment's durable single-collection
queue constraint without adding Redis or Kafka.

| Assignment condition | Implementation |
| --- | --- |
| Traffic with five-second work | Bounded concurrency: `100 × 60 / 5 ≈ 1,200` theoretical slots/minute. |
| Sender retries | Global idempotency key, normalized payload hash, and unique index. |
| Immediate response | Persist and receive acknowledgement, then return HTTP 202. |
| Per-patient state | MongoDB-enforced serialization; different patients run concurrently. |
| Crashes and restarts | Renewable leases, retries, expired-lease recovery, and claim-token fencing. |
| Out-of-order delivery | `ts` ordering with `_id` tie-breaker and the late-arrival limitation below. |

Concurrency defaults to 100 and is bounded rather than creating unlimited
promises. A unique partial index permits one lock-holding event per patient across
instances. Retrying events retain that lock, so later queued events cannot
overtake them.

### Guarantees and limitations

- Processing is retryable and at-least-once. Claim-token checks prevent a stale
  worker from recording completion after reclamation.
- A real downstream system must also accept the idempotency key: a crash can occur
  after its call succeeds but before MongoDB records completion. Exactly-once
  external effects are not claimed.
- Arbitrary late arrivals cannot be perfectly ordered using only `ts`; production
  needs a source sequence or watermark, or a replay strategy.
- Idempotency keys are global because sender identity is outside this assignment.
- Local Docker Compose uses standalone MongoDB. For it, `w: "majority"` still
  represents one node; production redundancy requires a replica set.

## Local development

For direct npm development with MongoDB in Docker:

```bash
npm install
cp .env.example .env
docker compose up -d mongo
npm run start:dev
```

| Variable | Purpose and default |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`; default `development`. |
| `PORT` | HTTP port; default `3000`. |
| `MONGO_URI` | Required MongoDB connection URI. |
| `WORKER_CONCURRENCY` | Positive bounded worker limit; default `100`. |

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The e2e suite requires Docker. Use `docker compose down --volumes` only when the
local database should also be deleted.

## Testing strategy

Fast Vitest tests cover validation, health, and canonical hashing. Testcontainers
tests use real MongoDB for persistence and idempotency races, asynchronous
completion, bounded coordination, per-patient ordering, retries, and lease
recovery. Injected processors and timing keep worker tests fast.

## Production follow-ups

- Deploy a multi-node MongoDB replica set and verify durability settings.
- Add sender-scoped identity and source sequence numbers or watermarks.
- Require downstream idempotency.
- Add metrics, alerting, and backlog monitoring.
- Separate API and worker deployments if traffic growth warrants it.
