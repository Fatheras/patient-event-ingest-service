import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { EventProcessor, type ProcessableEvent } from './event-processor.js';
import { EventRecord } from './event.schema.js';
import type { JsonObject } from './event.validation.js';
import {
  EVENT_WORKER_OPTIONS,
  type EventWorkerOptions,
} from './events-worker.options.js';

interface ClaimedEvent extends ProcessableEvent {
  claimToken: string;
}

@Injectable()
export class EventsWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(EventsWorker.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly activeTasks = new Set<Promise<void>>();
  private loopPromise?: Promise<void>;
  private stopping = false;
  private wakePolling: (() => void) | undefined;

  constructor(
    @InjectModel(EventRecord.name)
    private readonly eventModel: Model<EventRecord>,
    private readonly processor: EventProcessor,
    @Inject(EVENT_WORKER_OPTIONS)
    private readonly options: EventWorkerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.autoStart) {
      this.start();
    }
  }

  start(): void {
    if (!this.loopPromise) {
      this.loopPromise = this.runLoop();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wakePolling?.();
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const excludedPatients = new Set<string>();
      let claimedWork = false;

      while (
        !this.stopping &&
        this.activeTasks.size < this.options.concurrency
      ) {
        let event: ClaimedEvent | null;

        try {
          event = await this.claimNextEvent([...excludedPatients]);
        } catch (error: unknown) {
          const blockedPatient = duplicatePatientLease(error);
          if (blockedPatient) {
            excludedPatients.add(blockedPatient);
            continue;
          }

          this.logger.error('Failed to claim an event', error);
          break;
        }

        if (!event) {
          break;
        }

        claimedWork = true;
        this.startProcessing(event);
      }

      if (this.stopping) {
        break;
      }

      if (this.activeTasks.size >= this.options.concurrency) {
        await Promise.race(this.activeTasks);
      } else if (!claimedWork) {
        await this.waitForPoll();
      }
    }

    await Promise.allSettled(this.activeTasks);
  }

  private async claimNextEvent(
    excludedPatients: string[],
  ): Promise<ClaimedEvent | null> {
    const now = new Date();
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.options.leaseDurationMs);
    const patientFilter =
      excludedPatients.length > 0
        ? { patientId: { $nin: excludedPatients } }
        : {};

    const event = await this.eventModel.collection.findOneAndUpdate(
      {
        ...patientFilter,
        $or: [
          {
            status: 'pending',
            $or: [
              { nextAttemptAt: { $exists: false } },
              { nextAttemptAt: { $lte: now } },
            ],
          },
          { status: 'processing', leaseExpiresAt: { $lte: now } },
        ],
      },
      [
        {
          $set: {
            status: 'processing',
            patientLeaseKey: '$patientId',
            leaseOwner: this.workerId,
            claimToken: { $literal: claimToken },
            leaseExpiresAt: { $literal: leaseExpiresAt },
            attemptCount: { $add: [{ $ifNull: ['$attemptCount', 0] }, 1] },
            updatedAt: { $literal: now },
          },
        },
      ],
      {
        returnDocument: 'after',
        sort: { patientLeaseKey: -1, ts: 1, _id: 1 },
      },
    );

    if (!event) {
      return null;
    }

    return {
      eventId: event._id.toString(),
      patientId: event.patientId as string,
      type: event.type as string,
      data: event.data as JsonObject,
      ts: event.ts as Date,
      attemptCount: event.attemptCount as number,
      claimToken,
    };
  }

  private startProcessing(event: ClaimedEvent): void {
    const task = this.processClaim(event)
      .catch((error: unknown) => {
        this.logger.error(`Unexpected worker failure for event ${event.eventId}`, error);
      })
      .finally(() => {
        this.activeTasks.delete(task);
        this.wakePolling?.();
      });

    this.activeTasks.add(task);
  }

  private async processClaim(event: ClaimedEvent): Promise<void> {
    const heartbeatController = new AbortController();
    const heartbeat = this.renewLease(event, heartbeatController.signal).catch(
      (error: unknown) => {
        this.logger.error(
          `Failed to renew the lease for event ${event.eventId}`,
          error,
        );
      },
    );

    try {
      const result = await this.processor.process(event);
      await this.complete(event, result);
    } catch (error: unknown) {
      await this.recordFailure(event, error);
    } finally {
      heartbeatController.abort();
      await heartbeat;
    }
  }

  private async renewLease(
    event: ClaimedEvent,
    signal: AbortSignal,
  ): Promise<void> {
    const heartbeatInterval = Math.max(
      1,
      Math.floor(this.options.leaseDurationMs / 3),
    );

    while (!signal.aborted) {
      await sleep(heartbeatInterval, signal);
      if (signal.aborted) {
        return;
      }

      const leaseExpiresAt = new Date(Date.now() + this.options.leaseDurationMs);
      const result = await this.eventModel.updateOne(
        {
          _id: event.eventId,
          status: 'processing',
          claimToken: event.claimToken,
          leaseOwner: this.workerId,
        },
        { $set: { leaseExpiresAt } },
      );

      if (result.modifiedCount === 0) {
        return;
      }
    }
  }

  private async complete(
    event: ClaimedEvent,
    result: JsonObject,
  ): Promise<void> {
    const now = new Date();
    await this.eventModel.updateOne(
      {
        _id: event.eventId,
        status: 'processing',
        claimToken: event.claimToken,
        leaseOwner: this.workerId,
      },
      {
        $set: {
          status: 'processed',
          processedAt: now,
          result,
          updatedAt: now,
        },
        $unset: {
          patientLeaseKey: 1,
          leaseOwner: 1,
          claimToken: 1,
          leaseExpiresAt: 1,
          nextAttemptAt: 1,
          lastError: 1,
        },
      },
    );
  }

  private async recordFailure(
    event: ClaimedEvent,
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    const backoffMs = Math.min(
      this.options.retryBaseDelayMs * 2 ** Math.max(0, event.attemptCount - 1),
      this.options.retryMaxDelayMs,
    );

    await this.eventModel.updateOne(
      {
        _id: event.eventId,
        status: 'processing',
        claimToken: event.claimToken,
        leaseOwner: this.workerId,
      },
      {
        $set: {
          status: 'pending',
          nextAttemptAt: new Date(now.getTime() + backoffMs),
          lastError: errorMessage(error),
          updatedAt: now,
        },
        $unset: { leaseOwner: 1, claimToken: 1, leaseExpiresAt: 1 },
      },
    );
  }

  private async waitForPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.options.pollIntervalMs);
      this.wakePolling = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wakePolling = undefined;
  }
}

function duplicatePatientLease(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 11_000 ||
    !('keyValue' in error) ||
    typeof error.keyValue !== 'object' ||
    error.keyValue === null ||
    !('patientLeaseKey' in error.keyValue) ||
    typeof error.keyValue.patientLeaseKey !== 'string'
  ) {
    return undefined;
  }

  return error.keyValue.patientLeaseKey;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
