import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { RequestIdMiddleware, REQUEST_ID_HEADER } from './common/http';
import { AuthModule } from './common/auth';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { CoursesModule } from './modules/courses/courses.module';
import { QuestionsModule } from './modules/questions';
import { LiveSessionsModule } from './modules/live-sessions';
import { ParticipantsModule } from './modules/participants';
import { SubmissionsModule } from './modules/submissions';
import { RealtimeModule } from './modules/realtime';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { PINO_REDACT_PATHS, PINO_REDACT_REMOVE } from './common/observability';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitModule } from './modules/rate-limit/rate-limit.module';
import { GovernanceModule } from './modules/governance/governance.module';

/**
 * Resolve env file by NODE_ENV so application runtime and the Prisma CLI
 * (prisma.config.ts) load the same environment. Mirrors prisma.config.ts.
 */
function envFilePath(): string[] {
  switch (process.env.NODE_ENV) {
    case 'production':
      return ['.env.production', '.env'];
    case 'test':
      return ['.env.test', '.env'];
    default:
      return ['.env.development', '.env'];
  }
}

const isProduction = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: envFilePath(),
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: isProduction ? 'info' : 'debug',
        redact: {
          paths: PINO_REDACT_PATHS,
          remove: PINO_REDACT_REMOVE,
        },
        transport: isProduction
          ? undefined
          : {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                colorize: true,
                translateTime: 'SYS:standard',
              },
            },
      },
    }),
    PrismaModule,
    AuthModule,
    RateLimitModule,
    HealthModule,
    IdentityModule,
    CoursesModule,
    QuestionsModule,
    LiveSessionsModule,
    ParticipantsModule,
    SubmissionsModule,
    RealtimeModule,
    EnrollmentsModule,
    GovernanceModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Stamp request ID on every route (health excluded from /api prefix
    // but still benefits from id + response header).
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

export { REQUEST_ID_HEADER };
