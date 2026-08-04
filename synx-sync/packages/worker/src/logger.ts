import type { Context } from 'hono';

/**
 * 结构化错误日志：输出单行 JSON，携带 requestId 便于用 wrangler tail 按请求关联。
 * 刻意不记录请求体、Authorization 头等敏感信息，避免 token 泄露进日志。
 *
 * @param c Hono 上下文（用于取 requestId 与请求信息）
 * @param event 稳定的事件名，如 'storage_retention_get_failed'
 * @param err 抛出的错误
 * @param extra 额外诊断字段（白名单，禁止放 secrets）
 */
export function logError(c: Context, event: string, err: unknown, extra?: Record<string, unknown>): void {
  const requestId = c.get('requestId') ?? 'unknown';
  console.error(JSON.stringify({
    event,
    requestId,
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    ...extra,
  }));
}

/** 结构化请求日志（非错误路径用） */
export function logInfo(c: Context, event: string, extra?: Record<string, unknown>): void {
  const requestId = c.get('requestId') ?? 'unknown';
  console.log(JSON.stringify({
    event,
    requestId,
    method: c.req.method,
    path: c.req.path,
    ...extra,
  }));
}
