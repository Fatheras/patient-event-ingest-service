import { createHash } from 'node:crypto';
import type { EventPayload, JsonValue } from './event.validation.js';

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as JsonValue)]),
    );
  }

  return value;
}

export function hashEventPayload(payload: EventPayload): string {
  const normalizedPayload: JsonValue = {
    data: payload.data,
    patientId: payload.patientId,
    ts: new Date(payload.ts).toISOString(),
    type: payload.type,
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalize(normalizedPayload)))
    .digest('hex');
}
