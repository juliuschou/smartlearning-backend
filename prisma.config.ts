// Prisma CLI 設定（Prisma 7 新制：datasource.url 從 schema.prisma 移至此處）
// 依 NODE_ENV 載入對應環境變數檔，開發環境預設使用 .env.development
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : process.env.NODE_ENV === "test"
      ? ".env.test"
      : ".env.development";

dotenv.config({ path: envFile });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});