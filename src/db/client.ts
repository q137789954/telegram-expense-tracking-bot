import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../config/env.js';
import * as schema from './schema.js';

// 复用 pg 连接池，供 Drizzle ORM 访问 PostgreSQL。
const pool = new Pool({
  connectionString: env.databaseUrl,
});

// 导出带 schema 的 Drizzle 客户端，方便类型推断。
export const db = drizzle(pool, { schema });

export async function closeDb() {
  // 在需要优雅关闭时调用，释放连接池资源。
  await pool.end();
}
