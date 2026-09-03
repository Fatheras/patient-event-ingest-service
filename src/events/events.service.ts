import {
  ConflictException,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { EventRecord } from './event.schema.js';
import type { EventPayload } from './event.validation.js';
import { hashEventPayload } from './payload-hash.js';

export interface AcceptedEvent {
  eventId: string;
  status: 'accepted';
}

@Injectable()
export class EventsService implements OnModuleInit {
  constructor(
    @InjectModel(EventRecord.name)
    private readonly eventModel: Model<EventRecord>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventModel.init();
  }

  async accept(
    idempotencyKey: string,
    payload: EventPayload,
  ): Promise<AcceptedEvent> {
    const payloadHash = hashEventPayload(payload);

    try {
      const event = await this.eventModel.create({
        idempotencyKey,
        payloadHash,
        patientId: payload.patientId,
        type: payload.type,
        data: payload.data,
        ts: new Date(payload.ts),
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: new Date(),
      });

      return { eventId: event.id as string, status: 'accepted' };
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const existingEvent = await this.eventModel
        .findOne({ idempotencyKey })
        .select({ _id: 1, payloadHash: 1 })
        .lean()
        .exec();

      if (!existingEvent) {
        throw error;
      }

      if (existingEvent.payloadHash !== payloadHash) {
        throw new ConflictException(
          'Idempotency-Key was already used for a different payload',
        );
      }

      return {
        eventId: existingEvent._id.toString(),
        status: 'accepted',
      };
    }
  }
}

function isDuplicateKeyError(error: unknown): error is { code: 11_000 } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}
