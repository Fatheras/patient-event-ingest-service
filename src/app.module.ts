import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { environmentValidationSchema } from './config/environment.validation.js';
import { EventsModule } from './events/events.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: environmentValidationSchema,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('MONGO_URI'),
        serverSelectionTimeoutMS: 5_000,
        writeConcern: { w: 'majority', journal: true, wtimeoutMS: 5_000 },
        retryAttempts: 0,
      }),
    }),
    EventsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
