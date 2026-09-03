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

## Checks and tests

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The e2e test starts an isolated MongoDB container and therefore requires Docker.
