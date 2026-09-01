import { Global, Module } from '@nestjs/common';
import { ApplicationLifecycleMiddleware } from './application-lifecycle.middleware';
import { ApplicationLifecycleService } from './application-lifecycle.service';

@Global()
@Module({
  providers: [ApplicationLifecycleService, ApplicationLifecycleMiddleware],
  exports: [ApplicationLifecycleService, ApplicationLifecycleMiddleware],
})
export class ApplicationLifecycleModule {}
