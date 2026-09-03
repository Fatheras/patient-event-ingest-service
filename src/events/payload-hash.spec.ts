import { describe, expect, it } from 'vitest';
import { hashEventPayload } from './payload-hash.js';

describe('hashEventPayload', () => {
  it('ignores nested object key order and normalizes equivalent timestamps', () => {
    const firstHash = hashEventPayload({
      patientId: 'patient-1',
      type: 'observation',
      data: { outer: { beta: 2, alpha: 1 }, value: true },
      ts: '2026-09-03T12:00:00Z',
    });
    const secondHash = hashEventPayload({
      type: 'observation',
      patientId: 'patient-1',
      data: { value: true, outer: { alpha: 1, beta: 2 } },
      ts: '2026-09-03T07:00:00-05:00',
    });

    expect(secondHash).toBe(firstHash);
  });

  it('preserves array order', () => {
    const payload = {
      patientId: 'patient-1',
      type: 'observation',
      ts: '2026-09-03T12:00:00Z',
    };

    expect(hashEventPayload({ ...payload, data: { values: [1, 2] } })).not.toBe(
      hashEventPayload({ ...payload, data: { values: [2, 1] } }),
    );
  });
});
