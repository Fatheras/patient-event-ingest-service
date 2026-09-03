# Patient Event Ingest Service

This project is the foundation for a production-minded NestJS service that will ingest patient events. It currently provides validated runtime configuration, MongoDB connectivity, and a health endpoint; event ingestion will be added later.

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

## Checks and tests

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The e2e test starts an isolated MongoDB container and therefore requires Docker.
