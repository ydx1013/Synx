// Workers 绑定与环境变量类型
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  ENVIRONMENT: string;
}

/** Hono 上下文变量（由 auth 中间件注入） */
export interface AppVars {
  userId: string;
}
