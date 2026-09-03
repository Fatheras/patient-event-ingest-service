import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_WORKER_OPTIONS,
  type EventWorkerOptions,
} from '../src/events/events-worker.options.js';

const MONGODB_PORT = 27_017;
const disabledWorkerOptions: EventWorkerOptions = {
  autoStart: false,
  concurrency: 100,
  leaseDurationMs: 30_000,
  pollIntervalMs: 100,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 60_000,
};
const validPayload = {
  patientId: 'patient-123',
  type: 'observation.created',
  data: { reading: { unit: 'bpm', value: 72 } },
  ts: '2026-09-03T12:00:00Z',
};

describe('Application (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let mongoContainer: StartedTestContainer;

  beforeAll(async () => {
    mongoContainer = await new GenericContainer('mongo:8.0')
      .withExposedPorts(MONGODB_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
      .start();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PORT', '3000');
    vi.stubEnv(
      'MONGO_URI',
      `mongodb://${mongoContainer.getHost()}:${mongoContainer.getMappedPort(MONGODB_PORT)}/patient_events`,
    );

    const { AppModule } = await import('../src/app.module.js');
    const testingModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EVENT_WORKER_OPTIONS)
      .useValue(disabledWorkerOptions)
      .compile();

    app = testingModule.createNestApplication();
    await app.listen(0);
    connection = app.get<Connection>(getConnectionToken());

    if (!connection.db) {
      throw new Error('Mongoose did not establish a database connection');
    }

    const indexes = await connection.db.collection('events').indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        key: { idempotencyKey: 1 },
        unique: true,
      }),
    );
  }, 120_000);

  beforeEach(async () => {
    await connection.collection('events').deleteMany({});
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await mongoContainer?.stop();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  }, 120_000);

  it('serves its health endpoint and connects to MongoDB', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    await expect(connection.db?.admin().ping()).resolves.toMatchObject({
      ok: 1,
    });
  });

  it('accepts a valid event and persists it as pending', async () => {
    const response = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'valid-event')
      .send(validPayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      eventId: expect.any(String),
      status: 'accepted',
    });

    const persistedEvent = await connection
      .collection('events')
      .findOne({ idempotencyKey: 'valid-event' });
    expect(persistedEvent).toMatchObject({
      _id: expect.anything(),
      idempotencyKey: 'valid-event',
      payloadHash: expect.stringMatching(/^[a-f\d]{64}$/),
      patientId: validPayload.patientId,
      type: validPayload.type,
      data: validPayload.data,
      ts: new Date(validPayload.ts),
      status: 'pending',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(persistedEvent?._id.toString()).toBe(response.body.eventId);
  });

  it('rejects an invalid body and a missing Idempotency-Key', async () => {
    const invalidBodyResponse = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'invalid-event')
      .send({ ...validPayload, unexpected: true });
    const missingKeyResponse = await request(app.getHttpServer())
      .post('/events')
      .send(validPayload);

    expect(invalidBodyResponse.status).toBe(400);
    expect(missingKeyResponse.status).toBe(400);
    await expect(connection.collection('events').countDocuments()).resolves.toBe(
      0,
    );
  });

  it('returns the original event for a repeated identical request', async () => {
    const firstResponse = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'repeated-event')
      .send(validPayload);
    const secondResponse = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'repeated-event')
      .send({
        ...validPayload,
        data: { reading: { value: 72, unit: 'bpm' } },
      });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body.eventId).toBe(firstResponse.body.eventId);
    await expect(connection.collection('events').countDocuments()).resolves.toBe(
      1,
    );
  });

  it('handles concurrent identical requests without creating duplicates', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', 'concurrent-event')
          .send(validPayload),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual(
      Array.from({ length: 8 }, () => 202),
    );
    expect(new Set(responses.map(({ body }) => body.eventId)).size).toBe(1);
    await expect(connection.collection('events').countDocuments()).resolves.toBe(
      1,
    );
  });

  it('rejects reuse of a key for a different payload', async () => {
    const firstResponse = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'conflicting-event')
      .send(validPayload);
    const conflictingResponse = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'conflicting-event')
      .send({ ...validPayload, type: 'observation.corrected' });

    expect(firstResponse.status).toBe(202);
    expect(conflictingResponse.status).toBe(409);
    await expect(connection.collection('events').countDocuments()).resolves.toBe(
      1,
    );
  });
});
