import { z } from 'zod';

export const environmentValidationSchema = z.looseObject({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGO_URI: z.url({ protocol: /^mongodb(?:\+srv)?$/ }),
});
