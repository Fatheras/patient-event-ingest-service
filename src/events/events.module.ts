import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { EventProcessor, SlowEventProcessor } from './event-processor.js';
import { EventRecord, EventSchema } from './event.schema.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { EventsWorker } from './events.worker.js';
import {
  createEventWorkerOptions,
  EVENT_WORKER_OPTIONS,
} from './events-worker.options.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventRecord.name, schema: EventSchema },
    ]),
  ],
  controllers: [EventsController],
  providers: [
    EventsService,
    EventsWorker,
    SlowEventProcessor,
    { provide: EventProcessor, useExisting: SlowEventProcessor },
    {
      provide: EVENT_WORKER_OPTIONS,
      inject: [ConfigService],
      useFactory: createEventWorkerOptions,
    },
  ],
  exports: [EventsWorker],
})
export class EventsModule {}
