import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument } from 'mongoose';
import type { JsonObject } from './event.validation.js';

export type EventDocument = HydratedDocument<EventRecord>;

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

  @Prop({ enum: ['pending'], required: true })
  status!: 'pending';

  createdAt!: Date;
  updatedAt!: Date;
}

export const EventSchema = SchemaFactory.createForClass(EventRecord);

EventSchema.index({ idempotencyKey: 1 }, { unique: true });
