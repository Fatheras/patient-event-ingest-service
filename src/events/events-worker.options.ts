import { ConfigService } from '@nestjs/config';

export const EVENT_WORKER_OPTIONS = Symbol('EVENT_WORKER_OPTIONS');

export interface EventWorkerOptions {
  autoStart: boolean;
  concurrency: number;
  leaseDurationMs: number;
  pollIntervalMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export function createEventWorkerOptions(
  configService: ConfigService,
): EventWorkerOptions {
  return {
    autoStart: true,
    concurrency: configService.getOrThrow<number>('WORKER_CONCURRENCY'),
    leaseDurationMs: 30_000,
    pollIntervalMs: 100,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 60_000,
  };
}
