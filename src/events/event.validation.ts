import { z } from 'zod';

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonObject = Record<string, JsonValue>;

const jsonValueSchema = z.json();

export const eventPayloadSchema = z.strictObject({
  patientId: z.string().trim().min(1).max(128),
  type: z.string().trim().min(1).max(128),
  data: z.record(z.string(), jsonValueSchema),
  ts: z.iso.datetime({ offset: true }),
});

export type EventPayload = z.infer<typeof eventPayloadSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(256);
