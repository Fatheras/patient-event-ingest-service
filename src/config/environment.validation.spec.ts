import { describe, expect, it } from 'vitest';
import { environmentValidationSchema } from './environment.validation.js';

describe('environmentValidationSchema', () => {
  it('applies defaults, coerces the port, and preserves unrelated variables', () => {
    const result = environmentValidationSchema.parse({
      MONGO_URI: 'mongodb://localhost:27017/patient_events',
      PORT: '4000',
      UNRELATED_VARIABLE: 'preserved',
    });

    expect(result).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      MONGO_URI: 'mongodb://localhost:27017/patient_events',
      UNRELATED_VARIABLE: 'preserved',
    });
  });

  it.each([
    { MONGO_URI: 'https://localhost/patient_events' },
    { MONGO_URI: 'mongodb://localhost/patient_events', PORT: 0 },
    { MONGO_URI: 'mongodb://localhost/patient_events', NODE_ENV: 'staging' },
  ])('rejects invalid configuration: %o', (environment) => {
    expect(environmentValidationSchema.safeParse(environment).success).toBe(
      false,
    );
  });
});
