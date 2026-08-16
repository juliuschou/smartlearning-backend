import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { RequestIdMiddleware, REQUEST_ID_HEADER } from './common/http';
import { AuthModule } from './common/auth';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { CoursesModule } from './modules/courses/courses.module';
import { PrismaModule } from './prisma/prisma.module';

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
    HealthModule,
    IdentityModule,
    CoursesModule,
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
