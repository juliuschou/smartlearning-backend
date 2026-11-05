import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

dotenv.config({ path: '.env.development', quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required in .env.development');
}

const appDatabaseUrl = new URL(databaseUrl);
appDatabaseUrl.searchParams.set('schema', 'app');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: appDatabaseUrl.toString(),
  },
});
