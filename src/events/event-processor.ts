import { Injectable } from '@nestjs/common';
import type { JsonObject } from './event.validation.js';

export interface ProcessableEvent {
  eventId: string;
  patientId: string;
  type: string;
  data: JsonObject;
  ts: Date;
  attemptCount: number;
}

export abstract class EventProcessor {
  abstract process(event: ProcessableEvent): Promise<JsonObject>;
}

@Injectable()
export class SlowEventProcessor extends EventProcessor {
  async process(_event: ProcessableEvent): Promise<JsonObject> {
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));

    return { outcome: 'processed' };
  }
}
