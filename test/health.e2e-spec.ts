import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { describe, expect, it, vi } from 'vitest';

const MONGODB_PORT = 27_017;

describe('MongoDB connectivity (e2e)', () => {
  it('starts the application with MongoDB and serves its health endpoint', async () => {
    let app: INestApplication<App> | undefined;
    let mongoContainer: StartedTestContainer | undefined;

    try {
      mongoContainer = await new GenericContainer('mongo:8.0')
        .withExposedPorts(MONGODB_PORT)
        .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
        .start();
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('PORT', '3000');
      vi.stubEnv(
        'MONGO_URI',
        `mongodb://${mongoContainer.getHost()}:${mongoContainer.getMappedPort(MONGODB_PORT)}/patient_events`,
      );

      const { AppModule } = await import('../src/app.module.js');
      const testingModule: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = testingModule.createNestApplication();
      await app.init();

      const response = await request(app.getHttpServer()).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });

      const connection = app.get<Connection>(getConnectionToken());
      if (!connection.db) {
        throw new Error('Mongoose did not establish a database connection');
      }

      await expect(connection.db.admin().ping()).resolves.toMatchObject({
        ok: 1,
      });
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          await mongoContainer?.stop();
        } finally {
          vi.unstubAllEnvs();
        }
      }
    }
  }, 120_000);
});
