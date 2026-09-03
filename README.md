# Patient Event Ingest Service

This project is a production-minded NestJS service that durably accepts patient events. It provides validated runtime configuration, MongoDB persistence, idempotent event acceptance, and a health endpoint.

## Prerequisites

- Node.js 24 LTS (use `nvm use` with the included `.nvmrc`)
- npm
- Docker with Docker Compose

## Local development

```bash
npm install
cp .env.example .env
docker compose up -d mongo
npm run start:dev
```

## Docker Compose

```bash
docker compose up --build -d
docker compose down
```

The named MongoDB volume is preserved by `docker compose down`.

## Accept an event

```bash
curl --request POST http://localhost:3000/events \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: example-event-1' \
  --data '{"patientId":"patient-123","type":"observation.created","data":{"value":72},"ts":"2026-09-03T12:00:00Z"}'
```

A successful request returns HTTP 202 with
`{"eventId":"<id>","status":"accepted"}`. `Idempotency-Key` is required so
clients can safely retry: the same key and normalized payload return the original
event, while using the key for a different payload returns HTTP 409. Keys are
currently global across all patients and event types.

## Background processing

An in-process worker claims events atomically in MongoDB and processes them with
bounded concurrency. The default of 100 workers provides about 1,200 five-second
processing slots per minute, slightly above the expected 1,000 events per minute;
set `WORKER_CONCURRENCY` to tune it. Claims use renewable leases, so another
instance can recover work after a crashed worker's lease expires. A unique partial
index serializes processing per patient, and retries retain that patient's lock so
later events cannot overtake a failed event.

Within the currently queued set, patient events are selected by timestamp and a
deterministic ID tie-breaker. Arbitrarily late arrival cannot be perfectly ordered
from `ts` alone; a production contract would need a source sequence or watermark,
or an explicit replay strategy. MongoDB records one processing outcome, but a real
external side effect must also accept the idempotency key: a process can crash
after the external call and before recording completion in MongoDB.

## Checks and tests

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The e2e test starts an isolated MongoDB container and therefore requires Docker.
