import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EventProcessor,
  type ProcessableEvent,
} from '../src/events/event-processor.js';
import type { JsonObject } from '../src/events/event.validation.js';
import { EventsWorker } from '../src/events/events.worker.js';
import {
  EVENT_WORKER_OPTIONS,
  type EventWorkerOptions,
} from '../src/events/events-worker.options.js';

const MONGODB_PORT = 27_017;
const testWorkerOptions: EventWorkerOptions = {
  autoStart: false,
  concurrency: 4,
  leaseDurationMs: 500,
  pollIntervalMs: 10,
  retryBaseDelayMs: 30,
  retryMaxDelayMs: 60,
};

class ControlledProcessor extends EventProcessor {
  handler: (event: ProcessableEvent) => Promise<JsonObject> = async () => ({
    outcome: 'processed',
  });

  process(event: ProcessableEvent): Promise<JsonObject> {
    return this.handler(event);
  }
}

describe('EventsWorker coordination (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let connection: Connection;
  let mongoContainer: StartedTestContainer;
  let processor: ControlledProcessor;
  let worker: EventsWorker;

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
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    try {
      await mongoContainer.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);

  async function createApplication(): Promise<void> {
    processor = new ControlledProcessor();
    const { AppModule } = await import('../src/app.module.js');
    const testingModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EventProcessor)
      .useValue(processor)
      .overrideProvider(EVENT_WORKER_OPTIONS)
      .useValue(testWorkerOptions)
      .compile();

    app = testingModule.createNestApplication();
    await app.listen(0);
    connection = app.get<Connection>(getConnectionToken());
    await connection.collection('events').deleteMany({});
    worker = app.get(EventsWorker);
  }

  async function acceptEvent(
    key: string,
    patientId: string,
    ts: string,
    data: JsonObject = {},
  ): Promise<string> {
    if (!app) {
      throw new Error('Test application is not running');
    }

    const response = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', key)
      .send({ patientId, type: 'observation.created', data, ts });

    expect(response.status).toBe(202);
    return response.body.eventId as string;
  }

  it('returns an accepted response before processing completes', async () => {
    await createApplication();
    const processing = deferred<JsonObject>();
    let processingCompleted = false;
    processor.handler = async () => {
      const result = await processing.promise;
      processingCompleted = true;
      return result;
    };
    worker.start();

    const eventId = await acceptEvent(
      'fast-ingress',
      'patient-fast',
      '2026-09-03T12:00:00Z',
    );

    expect(processingCompleted).toBe(false);
    processing.resolve({ outcome: 'processed' });
    await waitForEvent(eventId, { status: 'processed' });
  });

  it('eventually stores the processed result', async () => {
    await createApplication();
    worker.start();

    const eventId = await acceptEvent(
      'eventual-result',
      'patient-result',
      '2026-09-03T12:00:00Z',
    );
    const event = await waitForEvent(eventId, { status: 'processed' });

    expect(event).toMatchObject({
      status: 'processed',
      processedAt: expect.any(Date),
      result: { outcome: 'processed' },
      attemptCount: 1,
    });
  });

  it('processes different patients concurrently', async () => {
    await createApplication();
    const releases = new Map<string, ReturnType<typeof deferred<JsonObject>>>();
    const started = new Set<string>();
    processor.handler = async (event) => {
      started.add(event.patientId);
      const release = deferred<JsonObject>();
      releases.set(event.patientId, release);
      return release.promise;
    };
    const firstId = await acceptEvent(
      'concurrent-a',
      'patient-a',
      '2026-09-03T12:00:00Z',
    );
    const secondId = await acceptEvent(
      'concurrent-b',
      'patient-b',
      '2026-09-03T12:00:00Z',
    );

    worker.start();
    await waitFor(() => started.size === 2);

    releases.get('patient-a')?.resolve({ outcome: 'processed' });
    releases.get('patient-b')?.resolve({ outcome: 'processed' });
    await Promise.all([
      waitForEvent(firstId, { status: 'processed' }),
      waitForEvent(secondId, { status: 'processed' }),
    ]);
  });

  it('processes one patient sequentially in timestamp order', async () => {
    await createApplication();
    const starts: string[] = [];
    const releases = new Map<string, ReturnType<typeof deferred<JsonObject>>>();
    processor.handler = async (event) => {
      const order = event.data.order as string;
      starts.push(order);
      const release = deferred<JsonObject>();
      releases.set(order, release);
      return release.promise;
    };
    const laterId = await acceptEvent(
      'ordered-later',
      'patient-ordered',
      '2026-09-03T12:00:01Z',
      { order: 'later' },
    );
    const earlierId = await acceptEvent(
      'ordered-earlier',
      'patient-ordered',
      '2026-09-03T12:00:00Z',
      { order: 'earlier' },
    );

    worker.start();
    await waitFor(() => starts.length === 1);
    expect(starts).toEqual(['earlier']);
    await delay(50);
    expect(starts).toEqual(['earlier']);

    releases.get('earlier')?.resolve({ outcome: 'processed' });
    await waitFor(() => starts.length === 2);
    expect(starts).toEqual(['earlier', 'later']);
    releases.get('later')?.resolve({ outcome: 'processed' });
    await Promise.all([
      waitForEvent(earlierId, { status: 'processed' }),
      waitForEvent(laterId, { status: 'processed' }),
    ]);
  });

  it('reclaims an expired lease', async () => {
    await createApplication();
    const eventId = await acceptEvent(
      'expired-lease',
      'patient-expired',
      '2026-09-03T12:00:00Z',
    );
    await connection.collection('events').updateOne(
      { _id: new Types.ObjectId(eventId) },
      {
        $set: {
          status: 'processing',
          attemptCount: 1,
          patientLeaseKey: 'patient-expired',
          leaseOwner: 'crashed-worker',
          claimToken: 'expired-token',
          leaseExpiresAt: new Date(Date.now() - 1_000),
        },
      },
    );

    worker.start();
    const event = await waitForEvent(eventId, { status: 'processed' });
    expect(event.attemptCount).toBe(2);
  });

  it('retries a transient failure before processing the next patient event', async () => {
    await createApplication();
    const starts: string[] = [];
    processor.handler = async (event) => {
      const order = event.data.order as string;
      starts.push(`${order}:${event.attemptCount}`);
      if (order === 'first' && event.attemptCount === 1) {
        throw new Error('transient failure');
      }
      return { outcome: 'processed' };
    };
    const firstId = await acceptEvent(
      'retry-first',
      'patient-retry',
      '2026-09-03T12:00:00Z',
      { order: 'first' },
    );
    const secondId = await acceptEvent(
      'retry-second',
      'patient-retry',
      '2026-09-03T12:00:01Z',
      { order: 'second' },
    );

    worker.start();
    await Promise.all([
      waitForEvent(firstId, { status: 'processed' }),
      waitForEvent(secondId, { status: 'processed' }),
    ]);

    expect(starts).toEqual(['first:1', 'first:2', 'second:1']);
    const firstEvent = await connection.collection('events').findOne({
      _id: new Types.ObjectId(firstId),
    });
    expect(firstEvent).toMatchObject({ attemptCount: 2, status: 'processed' });
  });

  async function waitForEvent(
    eventId: string,
    expected: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let event: Record<string, unknown> | null = null;
    await waitFor(async () => {
      event = await connection
        .collection('events')
        .findOne({ _id: new Types.ObjectId(eventId) });
      return event !== null && matches(event, expected);
    });
    if (event === null) {
      throw new Error('Event disappeared after matching the expected state');
    }
    return event;
  }
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for worker state');
    }
    await delay(10);
  }
}

function matches(
  value: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, expectedValue]) =>
    Object.is(value[key], expectedValue),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
