import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  eventPayloadSchema,
  idempotencyKeySchema,
} from './event.validation.js';
import { EventsService, type AcceptedEvent } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async createEvent(
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body() rawPayload: unknown,
  ): Promise<AcceptedEvent> {
    const idempotencyKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (!idempotencyKey.success) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }

    const payload = eventPayloadSchema.safeParse(rawPayload);
    if (!payload.success) {
      throw new BadRequestException('Invalid event payload');
    }

    return this.eventsService.accept(idempotencyKey.data, payload.data);
  }
}
