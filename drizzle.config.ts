import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Drizzle Kit 配置：用于生成迁移与类型。
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
