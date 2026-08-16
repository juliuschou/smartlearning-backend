import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TransactionService } from './transaction.service';

/**
 * PrismaModule — global module so the whole app can inject PrismaService /
 * TransactionService without re-importing.
 */
@Global()
@Module({
  providers: [PrismaService, TransactionService],
  exports: [PrismaService, TransactionService],
})
export class PrismaModule {}
