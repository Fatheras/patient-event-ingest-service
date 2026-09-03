# Patient Event Ingest Service

This NestJS service is the HTTP entry point for patient events sent by third
parties. It validates and durably records each accepted event in MongoDB, then an
in-process worker handles it asynchronously. The API returns HTTP 202 before the
five-second simulated processing finishes so request latency is limited to
validation and the acknowledged database write, rather than downstream work.

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

```bash
curl --request POST http://localhost:3000/events \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: example-event-1' \
  --data '{"patientId":"patient-123","type":"observation.created","data":{"value":72},"ts":"2026-09-03T12:00:00Z"}'
```

- `202 Accepted`: MongoDB acknowledged the event. The response is
  `{"eventId":"<id>","status":"accepted"}`.
- `400 Bad Request`: the header is missing or invalid, or the strict payload
  validation fails.
- `409 Conflict`: the idempotency key already belongs to a different normalized
  payload.

Repeating the same key and normalized payload returns HTTP 202 with the original
event ID and does not create another document. Payload hashes canonicalize nested
object keys, so JSON property order does not affect duplicate detection. The
health check is available at `GET /health`.

## Architecture and lifecycle

1. The controller validates the header and body with Zod.
2. The API inserts an event with `pending` status and waits for MongoDB to
   acknowledge it before returning 202.
3. A worker atomically claims eligible work in MongoDB, changes it to
   `processing`, and records a renewable lease owner and claim token.
4. Successful processing records `processedAt`, the result
   `{"outcome":"processed"}`, and `processed` status.
5. Failures return to `pending` with capped exponential backoff and the last
   error. An expired lease can be reclaimed after a process crash.

Queue state, attempts, leases, errors, and outcomes all remain in the single
`events` collection. MongoDB is also the durable queue because that satisfies the
assignment's single-collection constraint and avoids adding Redis or Kafka and
their operational overhead.

## Design reasoning

Processing concurrency is bounded and configurable, rather than creating an
unbounded number of promises. Its default is 100: `100 × 60 / 5 ≈ 1,200`
theoretical processing slots per minute, slightly above the expected 1,000 events
per minute.

Different patients can use those slots concurrently. For one patient, a unique
partial index permits only one lock-holding event, including across service
instances. Queued events are selected by event timestamp and MongoDB `_id` as a
deterministic tie-breaker. A retry retains the patient's database lock, preventing
a later event from overtaking it. The idempotency-key unique index likewise makes
concurrent event acceptance race-safe. Renewable MongoDB leases allow another
process to recover abandoned work after a restart.

## Guarantees and limitations

- HTTP 202 means MongoDB acknowledged persistence; it does not mean processing
  has finished.
- A global idempotency key identifies one MongoDB event and recorded outcome.
  Keys are global because sender identity is outside this assignment's contract.
- Processing is retryable and at-least-once. Lease ownership and claim tokens
  prevent a stale worker from recording completion after another claim takes over.
- A real external system must also accept the idempotency key. A worker can crash
  after an external call succeeds but before completion is stored in MongoDB, so
  the service does not claim exactly-once external side effects.
- Events already queued for a patient are ordered by `ts` and `_id`, but
  arbitrarily late arrival cannot be ordered perfectly from `ts` alone. A
  production contract needs a source sequence or watermark, or a replay strategy.

## Local development

Prerequisites are Node.js 24 LTS, npm, and Docker with Docker Compose. Use
`nvm use` with the included `.nvmrc` if desired.

Start the complete stack:

```bash
docker compose up --build -d
docker compose logs -f app
```

For direct npm development with only MongoDB in Docker:

```bash
npm install
cp .env.example .env
docker compose up -d mongo
npm run start:dev
```

Environment variables:

- `NODE_ENV`: `development`, `test`, or `production`; defaults to `development`.
- `PORT`: HTTP port; defaults to `3000`.
- `MONGO_URI`: required MongoDB connection URI.
- `WORKER_CONCURRENCY`: positive worker limit; defaults to `100`.

Checks and tests:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The e2e suite requires Docker. Stop services with `docker compose down`, which
preserves the named MongoDB volume. Use `docker compose down --volumes` when the
local database should also be deleted.

## Testing strategy

Vitest unit tests cover pure validation, health, and canonical payload hashing.
The e2e suites use Testcontainers with real MongoDB and cover validation and
idempotency races, acknowledged persistence, asynchronous completion,
cross-patient concurrency, per-patient ordering, retries, and expired-lease
recovery. Worker tests inject controllable processing and timing so they do not
wait for the production five-second delay.

## Production follow-ups

- Run MongoDB as a replica set and choose explicit production durability settings.
- Add sender-scoped identity and source sequence numbers or watermarks.
- Require downstream systems to honor the event idempotency key.
- Add metrics, alerting, and backlog/lease monitoring.
- Consider separate API and worker deployments as traffic and scaling needs grow.
