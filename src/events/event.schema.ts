import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type Schema as MongooseSchema } from 'mongoose';
import type { JsonObject } from './event.validation.js';

@Schema({ collection: 'events', timestamps: true, versionKey: false })
export class EventRecord {
  @Prop({ required: true })
  idempotencyKey!: string;

  @Prop({ required: true })
  payloadHash!: string;

  @Prop({ required: true })
  patientId!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ required: true, type: SchemaTypes.Mixed })
  data!: JsonObject;

  @Prop({ required: true })
  ts!: Date;

  @Prop({ enum: ['pending', 'processing', 'processed'], required: true })
  status!: 'pending' | 'processing' | 'processed';

  @Prop({ default: 0, required: true })
  attemptCount!: number;

  @Prop({ default: Date.now, required: true })
  nextAttemptAt!: Date;

  @Prop()
  patientLeaseKey?: string;

  @Prop()
  leaseOwner?: string;

  @Prop()
  claimToken?: string;

  @Prop()
  leaseExpiresAt?: Date;

  @Prop()
  lastError?: string;

  @Prop()
  processedAt?: Date;

  @Prop({ type: SchemaTypes.Mixed })
  result?: JsonObject;

  createdAt!: Date;
  updatedAt!: Date;
}

export const EventSchema: MongooseSchema<EventRecord> =
  SchemaFactory.createForClass<object>(EventRecord) as MongooseSchema<EventRecord>;

EventSchema.index({ idempotencyKey: 1 }, { unique: true });
EventSchema.index(
  { patientLeaseKey: 1 },
  {
    unique: true,
    partialFilterExpression: { patientLeaseKey: { $type: 'string' } },
  },
);
EventSchema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, ts: 1 });
